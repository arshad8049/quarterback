#!/usr/bin/env node
// Arm-A batch 1: per-task SETUP qualification, no model, CI only (GITHUB_ACTIONS=true, ARM_A_CI_RUN=1).
//   1 starting code     the checkout is the task base, one commit (no future history)
//   2 coding environment QB's real runSandboxed path on the LOADED kan117 image set: QB's deps stage, then an
//                       agent-workspace probe (network none, read-only node_modules) that runs the task's own test
//                       command on the BASE tree. Qualified = the command runs to completion and reports results;
//                       existing failures are recorded, not rejected. Only counts and exit codes are kept.
//   4 agent input       the exact arm-A briefing (lib/pilot/arm-a.js, leak-checked) reaches the agent stage on stdin
//                       (sha256 compared inside the container) and /work is a one-commit repository with no remotes
//   5 QB compatibility  recorded separately from candidates.json (not a qualification criterion for Claude-only runs)
// (3, grader calibration, is grade.mjs --tasks-file --only=<key> in the same workflow job.)
//   node bench/opus-pilot/arm-a-qualify.mjs --task=<key> --repo=<checkout> --store=bench/public/out --images=<dir> --out=<dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.ARM_A_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
const key = arg('task'); const repo = arg('repo'); const store = arg('store'); const imagesDir = arg('images'); const outDir = arg('out');
if (!key || !repo || !store || !imagesDir || !outDir) { console.error('usage: arm-a-qualify.mjs --task= --repo= --store= --images= --out='); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { hardened, TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { armABriefing } = require(path.join(ROOT, 'lib/pilot/arm-a.js'));

const tasks = JSON.parse(fs.readFileSync(path.join(HERE, 'arm-a-grader-tasks.json'), 'utf8')).tasks;
const t = tasks[key]; if (!t) { console.error(`unknown task ${key}`); process.exit(2); }
const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === t.task_id);
const agentRow = row('agent'); const vaultRow = row('vault');
const rec = { schema: 'qb-arm-a-qualify/1', task: key, task_id: t.task_id, instance_id: t.instance_id, role: t.role, qb_commit: process.env.GITHUB_SHA || null };
const fail = (where, why) => { rec.qualified_setup = false; rec.setup_failure = { where, why }; };

// 1 starting code
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
rec.starting_code = { head: git('rev-parse', 'HEAD'), commits: Number(git('rev-list', '--all', '--count')) };
rec.starting_code.ok = rec.starting_code.head === t.base && rec.starting_code.commits === 1;
if (!rec.starting_code.ok) fail('starting_code', 'checkout is not the task base with one commit');

// 4 agent input (built before any sandbox; refused on any leak)
let b = null;
try { b = armABriefing(agentRow, vaultRow); rec.agent_input = { briefing_sha256: b.sha256, fields_shown: b.fields_shown, note: b.note, leak_findings: 0 }; }
catch (e) { rec.agent_input = { error: e.message }; fail('agent_input', e.message); }

// The task's own test command (the official eval's command between the markers), run on the BASE tree only
const ev = String(vaultRow.eval_script || '');
const m = /^: '>>>>> Start Test Output'\n([\s\S]*?)\n: '>>>>> End Test Output'$/m.exec(ev);
const testCmd = m ? m[1].trim() : null;
if (!testCmd || testCmd.includes('\n')) fail('coding_env', 'no single test command between the official markers');

if (rec.qualified_setup !== false) {
  const prov = JSON.parse(fs.readFileSync(path.join(imagesDir, 'image-provenance.json'), 'utf8'));
  const ids = {};
  for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
    const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
    if (!r.ok || r.stdout.trim() !== prov.images[name].id) { console.error(`${name}: not the loaded image`); process.exit(3); }
    ids[ref] = r.stdout.trim();
  }
  const release = D.bindImages(ids);
  let probe = null;
  const stage = async (ws, _egress, { waitTimeoutMs, briefing }) => {
    // stdin = the briefing (hashed in the container); then the base-tree test command with QB's installed deps.
    // Only key=value counts reach the record: never test names or output.
    const script = [
      'g() { git -c safe.directory="*" "$@"; }',
      'echo "stdin_sha256=$(sha256sum | cut -d" " -f1)" 1>&2',
      'echo "commits=$(g rev-list --all --count) refs=$(g for-each-ref | wc -l) remotes=$(g remote | wc -l)" 1>&2',
      `start=$(date +%s); ( ${testCmd} ) > /tmp/qbx-test.log 2>&1; ec=$?; end=$(date +%s)`,
      'echo "test_exit=$ec test_seconds=$((end-start))" 1>&2',
      'echo "tap_ok=$(grep -cE "^ok [0-9]+ " /tmp/qbx-test.log) tap_not_ok=$(grep -cE "^not ok [0-9]+ " /tmp/qbx-test.log)" 1>&2',
      'echo "karma_pass=$(grep -c "✔" /tmp/qbx-test.log) karma_fail=$(grep -c "✖" /tmp/qbx-test.log) karma_browser_started=$(grep -c "Starting browser" /tmp/qbx-test.log)" 1>&2',
      'echo "missing_browser=$(grep -ciE "no binary for|cannot start chrome|failed to launch|chrome_bin" /tmp/qbx-test.log) missing_module=$(grep -ciE "cannot find module|command not found|ERR_MODULE_NOT_FOUND" /tmp/qbx-test.log)" 1>&2',
    ].join('\n');
    const r = await D.runStage(`${ws.runId}-agent`, [
      ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), '-v', `${ws.runId}-deps:/work/node_modules:ro`,
      '-e', 'HOME=/tmp/home', '-e', 'CI=true', '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700', '-w', '/work', '--entrypoint', 'bash', AGENT_IMAGE, '-c', script,
    ], { input: Buffer.from(briefing), waitTimeoutMs });
    const kv = {};
    for (const l of String(r.stderr || '').split('\n')) for (const mm of l.matchAll(/([a-z_0-9]+)=(\S*)/g)) kv[mm[1]] = mm[2];
    probe = kv;
    return r;
  };
  const t0 = Date.now();
  const r = await runSandboxed({ repoPath: repo, briefing: b.briefing, agentStage: stage, verify: false, requireMemoryCheck: true,
    deadlines: { agent: 15 * 60_000 } });
  const launches = release();
  const n = (k) => (probe && /^\d+$/.test(probe[k] || '') ? Number(probe[k]) : null);
  rec.coding_env = {
    status: r.status, wall_ms: Date.now() - t0, deps: r.sandbox && r.sandbox.deps, agent_stage: r.sandbox && r.sandbox.stages && r.sandbox.stages.agent,
    capture: r.sandbox && r.sandbox.capture && r.sandbox.capture.verdict, test_command_sha256: require('node:crypto').createHash('sha256').update(testCmd).digest('hex'),
    test_exit: n('test_exit'), test_seconds: n('test_seconds'),
    results: { tap_ok: n('tap_ok'), tap_not_ok: n('tap_not_ok'), karma_pass: n('karma_pass'), karma_fail: n('karma_fail'), karma_browser_started: n('karma_browser_started') },
    signals: { missing_browser: n('missing_browser'), missing_module: n('missing_module') },
    launches: launches.length, distinct_images: [...new Set(launches.map((l) => l.image))],
  };
  rec.agent_input = { ...rec.agent_input, stdin_matches: !!probe && probe.stdin_sha256 === b.sha256, workspace_commits: n('commits'), workspace_refs: n('refs'), workspace_remotes: n('remotes') };
  const ran = (rec.coding_env.results.tap_ok + rec.coding_env.results.tap_not_ok + rec.coding_env.results.karma_pass + rec.coding_env.results.karma_fail) > 0;
  if (!r.sandbox || !r.sandbox.deps || r.sandbox.deps.status !== 'ready') fail('coding_env', `QB deps stage: ${r.sandbox && r.sandbox.deps ? `${r.sandbox.deps.status} ${r.sandbox.deps.reason || ''}`.trim() : r.status}`);
  else if (!probe || probe.test_exit === undefined) fail('coding_env', `the workspace probe did not complete (${r.status})`);
  else if (!ran) fail('coding_env', `the task's test command produced no test results (exit ${probe.test_exit}${n('missing_browser') ? ', no usable browser' : ''}${n('missing_module') ? ', missing module/command' : ''})`);
  else if (!rec.agent_input.stdin_matches || rec.agent_input.workspace_commits !== 1 || rec.agent_input.workspace_remotes !== 0) fail('agent_input', 'the agent stage did not receive exactly the briefing in a one-commit workspace without remotes');
  rec.coding_env.existing_failures = (rec.coding_env.results.tap_not_ok || 0) + (rec.coding_env.results.karma_fail || 0);
}

// 5 QB compatibility (separate; never a qualification criterion for Claude-only runs)
const cands = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/manifest/candidates.json'), 'utf8')).tasks;
const c = cands.find((x) => x.task_id === t.task_id);
rec.qb_compatibility = c ? { status: c.classification.status, reasons: c.classification.reasons, established: false } : { status: 'unknown', established: false };
if (rec.qualified_setup !== false) rec.qualified_setup = 'pending_calibration';
fs.writeFileSync(path.join(outDir, `qualify-${key}.json`), `${JSON.stringify(rec, null, 2)}\n`);
console.log(JSON.stringify({ task: key, qualified_setup: rec.qualified_setup, failure: rec.setup_failure || null, coding_env: rec.coding_env && { deps: rec.coding_env.deps && rec.coding_env.deps.status, test_exit: rec.coding_env.test_exit, results: rec.coding_env.results } }, null, 1));
process.exit(0);
