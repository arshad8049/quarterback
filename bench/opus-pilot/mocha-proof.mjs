#!/usr/bin/env node
// KAN-117 review 10620, slice A: no-model proof of the research-only Mocha channel through QB's REAL runSandboxed path
// (research env channel, verify-prep restores protected controls, deps volume read-only, network none, no credentials).
// CI only (GITHUB_ACTIONS=true, KAN117_CI_RUN=1). One task per invocation.
//   benchmark runs (visible outcomes only; the score is the independent grader's, recorded separately):
//     baseline  no agent (base tree): probe, the explicit file set, identity baseline (existing failures recorded)
//     empty     no agent, compared with the baseline
//     gold      controller-applied gold patch (applyPatch seam; never a prompt), compared with the baseline
//     tamper    controller-applied additions only: a .mocharc.json + a require hook + a new file under test/ ->
//               must change nothing (verify-prep removes the test/ addition; --no-config ignores the rc file)
//   --fixtures  benchmark-INDEPENDENT negative controls on a synthetic file set (qbx-fixture/), each must never PASS:
//               fail (a real failing test -> failed), zero tests, early process.exit (truncated report), forged
//               append to the report, a hook failure, and a hang past the stage cap (-> stage_timeout)
// Output: --out/mocha-proof-<key>.json (counts, verdicts, reasons, hashes; never test names or test output).
//   node bench/opus-pilot/mocha-proof.mjs --task=<key> --repo=<checkout at base> --store=bench/public/out --out=<dir> [--fixtures]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
const key = arg('task'); const repo = arg('repo'); const store = arg('store'); const outDir = arg('out');
if (!key || !repo || !store || !outDir) { console.error('usage: mocha-proof.mjs --task= --repo= --store= --out= [--fixtures]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { validateTaskEnv } = require(path.join(ROOT, 'lib/research/dataset-env.js'));
const { baselineFrom } = require(path.join(ROOT, 'verify/mocha-report.js'));
const envFile = path.join(HERE, 'mocha', `${key}.env.json`);
const ENV = validateTaskEnv(JSON.parse(fs.readFileSync(envFile, 'utf8')));
// review 10623: researchRootScripts and researchEnv TOGETHER through the real path (only for a record that names its entry)
const allowFile = arg('root-scripts-allow');
const ROOT_SCRIPTS = ENV.root_scripts_key
  ? (allowFile ? JSON.parse(fs.readFileSync(allowFile, 'utf8')).entries.filter((e) => e.key === ENV.root_scripts_key) : null) : null;
if (ENV.root_scripts_key && !(ROOT_SCRIPTS && ROOT_SCRIPTS.length === 1)) { console.error(`record names root_scripts_key ${ENV.root_scripts_key}: pass --root-scripts-allow with that one entry`); process.exit(2); }

const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== ENV.base_commit) { console.error(`checkout is ${head}, not the task base`); process.exit(3); }
const vaultRow = fs.readFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).find((r) => r.task_id === ENV.task_id);
if (!vaultRow || typeof vaultRow.patch !== 'string' || !vaultRow.patch) { console.error('vault row or gold patch missing'); process.exit(3); }

// the LOADED image set (image-bundle.mjs load ran first); every container must launch from these ids
const prov = JSON.parse(fs.readFileSync(path.join(arg('images') || process.env.IMG, 'image-provenance.json'), 'utf8'));
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== prov.images[name].id) { console.error(`${name}: not the loaded image`); process.exit(3); }
  ids[ref] = r.stdout.trim();
}
const release = D.bindImages(ids);

/** A patch that only ADDS files (no context needed). */
function addFiles(files) {
  return Object.entries(files).map(([f, body]) => {
    const lines = body.replace(/\n$/, '').split('\n');
    return `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  }).join('');
}

const TRIAL_TOTAL_MS = 90 * 60_000;
async function one(label, env, extra) {
  const t0 = Date.now();
  const r = await runSandboxed({ repoPath: repo, briefing: `KAN-117 mocha proof ${label} (no model)`, researchEnv: env,
    ...(ROOT_SCRIPTS ? { researchRootScripts: ROOT_SCRIPTS } : {}),
    requireMemoryCheck: true, researchDeadlineAtMs: t0 + TRIAL_TOTAL_MS, ...extra });
  return { label, wall_ms: Date.now() - t0, r };
}
const pick = (x) => {
  if (!x) return null;
  const s = x.r.sandbox || {}; const v = s.verification || {};
  const val = v.validation || {};
  return {
    status: x.r.status, wall_ms: x.wall_ms, deps: s.deps && { status: s.deps.status, reason: s.deps.reason || null, check_state: s.deps.check_state || null,
      root_scripts: s.deps.root_scripts ? { rule: s.deps.root_scripts.rule, removed: s.deps.root_scripts.removed, original_package_json_sha256: s.deps.root_scripts.original_package_json_sha256, install_manifest_sha256: s.deps.root_scripts.install_manifest_sha256, script_sha256: s.deps.root_scripts.script_sha256 } : null },
    capture: s.capture && s.capture.verdict && s.capture.verdict.state,
    // the gold run's changed paths are answer material: counted, never named
    changes: x.label === 'gold' ? { count: (x.r.changes || []).length } : (x.r.changes || []).map((c) => ({ file: c.file, status: c.status })),
    verification: { mode: v.mode, status: v.status, verdict: v.verdict, reasons: v.reasons, failed_step: v.failed_step || null,
      prep: v.prep && { status: v.prep.status, protected_modified: v.prep.protected_modified, test_script_changed: v.prep.test_script_changed },
      probe: v.probe || null, counts: val.counts || null, identity_set_sha256: val.identity_set_sha256 || null,
      files_expected: val.files_expected ?? null, files_executed: val.files_executed ?? null, reporter: v.reporter || null,
      test_step: (v.steps || []).filter((st) => st.name === 'test').map((st) => ({ state: st.state, exit_code: st.exit_code, duration_ms: st.duration_ms })) },
  };
};

// review 10624 follow-up (senior, 2026-11-15): --diagnose = the SAME visible command on the BASE tree in the agent
// workspace (network none, read-only node_modules), with Mocha's own JSON reporter, to identify each existing failure
// exactly (visible file, full title, code, first 300 chars of the message). Visible repository tests only.
const diag = [];
if (process.argv.includes('--diagnose')) {
  const { hardened } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
  const argv = [...ENV.test_argv, '--reporter', 'json', '--reporter-option', 'output=/tmp/qbx-diag.json', ...ENV.test_files];
  const q = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  const probe = async (ws, _e, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), '-v', `${ws.runId}-deps:/work/node_modules:ro`,
    '-e', 'HOME=/tmp/home', '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700', '-w', '/work', '--entrypoint', 'sh', AGENT_IMAGE, '-c',
    `${argv.map(q).join(' ')} >/dev/null 2>&1; echo "qbx_exit=$?" 1>&2; node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/qbx-diag.json","utf8"));for(const f of r.failures||[])console.error("QBDIAG "+JSON.stringify({file:String(f.file||"").replace(/^\/work\//,""),full_title:f.fullTitle,code:(f.err&&f.err.code)||null,message:String((f.err&&f.err.message)||"").slice(0,150)}))' 1>&2`,
  ], { waitTimeoutMs });
  const t0 = Date.now();
  const r = await runSandboxed({ repoPath: repo, briefing: 'KAN-117 mocha diagnose (no model)', researchEnv: ENV, ...(ROOT_SCRIPTS ? { researchRootScripts: ROOT_SCRIPTS } : {}),
    agentStage: probe, verify: false, requireMemoryCheck: true, researchDeadlineAtMs: t0 + TRIAL_TOTAL_MS });
  for (const l of String(r.stderr_tail || (r.sandbox && r.sandbox.stages && r.sandbox.stages.agent && r.sandbox.stages.agent.stderr) || '').split('\n')) {
    const m = /QBDIAG (\{.*\})$/.exec(l); if (!m) continue;
    try { const d = JSON.parse(m[1]); diag.push({ ...d, id: sha(`${d.file}\0${d.full_title}`) }); } catch { /* skip */ }
  }
  if (!diag.length) diag.push({ error: 'no diagnostic lines captured', status: r.status, stderr_keys: Object.keys(r).filter((k) => /stderr/.test(k)) });
}

const runs = {};
runs.baseline = await one('baseline', ENV, { noAgent: true });
let baseline = null;
try { baseline = baselineFrom(runs.baseline.r.sandbox.verification.validation); } catch { baseline = null; }
if (baseline) {
  runs.empty = await one('empty', ENV, { noAgent: true, researchBaseline: baseline });
  runs.gold = await one('gold', ENV, { applyPatch: vaultRow.patch, researchBaseline: baseline });
  runs.tamper = await one('tamper', ENV, { researchBaseline: baseline, applyPatch: addFiles({
    '.mocharc.json': '{ "spec": ["test/unit/utils/isFormData.js"], "reporter": "dot", "require": ["./qbx-tamper.js"] }',
    'qbx-tamper.js': "require('fs').writeFileSync('/tmp/qbx-tamper-ran', '1');",
    'test/unit/qbx-extra.js': "describe('qbx extra', () => { it('always passes', () => {}); });",
  }) });
}

// benchmark-independent negative controls: a synthetic file set, never the task's tests or answer
const fixtures = {};
if (process.argv.includes('--fixtures')) {
  const FX = 'qbx-fixture/f.cjs';   // CommonJS fixture: also loads in an ESM ("type": "module") package
  const fxEnv = (cap) => validateTaskEnv({ ...ENV, exposure: 'calibration', test_files: [FX], generated_paths: [], internal_stage_cap_ms: cap });
  const cases = {
    fail: "describe('fx', () => { it('passes', () => {}); it('fails', () => { throw new Error('synthetic'); }); });",
    zero_tests: "describe('fx', () => {});",
    early_exit: "describe('fx', () => { it('a', () => {}); it('b', () => { process.exit(0); }); });",
    forged_append: "describe('fx', () => { it('forges', () => { const o = process.argv.find((a) => a.startsWith('output=')).split(',')[0].slice(7); require('fs').appendFileSync(o, JSON.stringify({ type: 'qb:end', stats: { suites: 1, tests: 1, passes: 1, pending: 0, failures: 0 } }) + '\\n'); }); it('fails', () => { throw new Error('synthetic'); }); });",
    hook_failure: "describe('fx', () => { before(() => { throw new Error('synthetic hook'); }); it('a', () => {}); });",
    hang: "describe('fx', () => { it('hangs', function () { this.timeout(0); for (;;) {} }); });",
    // review 10623 item 4: test code that knows the nonce and output path (both in process.argv) REWRITES the whole
    // report with a self-consistent passing one after a real failure, then exits 0. Expected: NOT detectable (residual).
    complete_rewrite: "describe('fx', () => { it('really fails', () => { throw new Error('synthetic'); }); it('rewrites', () => { const a = process.argv[process.argv.indexOf('--reporter-option') + 1]; const o = Object.fromEntries(a.split(',').map((kv) => kv.split('='))); const f = __filename; const L = [{ type: 'qb:start', format: 'qb-mocha-events/1', nonce: o.nonce, mocha_version: o.mocha_version, started_at: Date.now() }, { type: 'suite', file: f }, { type: 'test', file: f, full_title: 'fx forged', title: 'forged', state: 'passed' }, { type: 'qb:end', stats: { suites: 1, tests: 1, passes: 1, pending: 0, failures: 0 } }]; require('fs').writeFileSync(o.output, L.map((l) => JSON.stringify(l)).join('\\n') + '\\n'); process.exit(0); }); });",
  };
  for (const [name, body] of Object.entries(cases)) {
    fixtures[name] = await one(`fixture-${name}`, fxEnv(name === 'hang' ? 120_000 : ENV.internal_stage_cap_ms), { applyPatch: addFiles({ [FX]: body }) });
  }
}
const launches = release();

// review 10623 item 3: diagnosis WITHOUT names — existing base failures and base→gold flips, by visible file, error kind/code,
// and whether the official test patch touches that test (controller-only: its leaf title is a string literal on a changed line)
const lit = new Set();
for (const l of String(vaultRow.test_patch || '').split('\n')) {
  if (!/^[-+]/.test(l) || /^(\+\+\+|---)/.test(l)) continue;
  for (const m of l.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) lit.add(sha(m[2]));
}
const idsOf = (x) => (x && x.r.sandbox && x.r.sandbox.verification && x.r.sandbox.verification.validation && x.r.sandbox.verification.validation.identities) || [];
const touched = (e) => (e.leaf_sha256 ? lit.has(e.leaf_sha256) : null);
const baseIds = new Map(idsOf(runs.baseline).map((e) => [e.id, e]));
const diagnosis = {
  base_failures: [...baseIds.values()].filter((e) => e.statuses.includes('failed')).map((e) => ({ file: e.file, kinds: e.kinds, codes: e.codes, touched_by_official_test_patch: touched(e) })),
  gold_flips: idsOf(runs.gold).filter((e) => { const b = baseIds.get(e.id); return !b || JSON.stringify(b.statuses) !== JSON.stringify(e.statuses); })
    .map((e) => ({ file: e.file, base: baseIds.has(e.id) ? baseIds.get(e.id).statuses : null, gold: e.statuses, kinds: e.kinds, codes: e.codes, touched_by_official_test_patch: touched(e) })),
  gold_missing: [...baseIds.keys()].filter((id) => !idsOf(runs.gold).some((e) => e.id === id)).length,
};

const left = async (kind) => { const x = await D.op(kind === 'container' ? ['ps', '-aq', '--filter', 'label=qb.run'] : [kind, 'ls', '-q', '--filter', 'label=qb.run']); return x.ok ? x.stdout.split('\n').filter(Boolean).length : null; };
const out = {
  schema: 'qb-kan117-mocha-proof/1', approved_by: 'KAN-117 10620 (slice A; no model)', task: key, task_id: ENV.task_id, exposure: ENV.exposure,
  qb_commit: process.env.GITHUB_SHA || null, task_env_sha256: sha(fs.readFileSync(envFile)), repo_head: head,
  mocha: { pinned: ENV.mocha_version, argv: ENV.test_argv, files: ENV.test_files, omitted: ENV.omitted },
  images: Object.fromEntries(Object.entries(ids)), distinct_launch_images: [...new Set(launches.map((l) => l.image))], launches: launches.length,
  baseline: baseline && { base_verdict: baseline.base_verdict, identity_set_sha256: baseline.identity_set_sha256, counts: baseline.counts },
  runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, pick(v)])),
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, pick(v)])),
  diagnose_base_failures: diag, diagnosis, budgets: { internal_stage_cap_ms: ENV.internal_stage_cap_ms, trial_total_ms: TRIAL_TOTAL_MS, mocha_timeout_ms: Number(ENV.test_argv[ENV.test_argv.indexOf('--timeout') + 1]) },
  cleanup: { containers: await left('container'), networks: await left('network'), volumes: await left('volume') },
  no_model: { model_calls: 0, credentials: 'none', agent_stage: 'none (baseline, empty); applyPatch (gold, tamper, fixtures)' },
};
fs.writeFileSync(path.join(outDir, `mocha-proof-${key}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ task: key, baseline: out.baseline, verdicts: Object.fromEntries([...Object.entries(out.runs), ...Object.entries(out.fixtures).map(([k, v]) => [`fixture:${k}`, v])].map(([k, v]) => [k, v && `${v.verification.verdict} ${(v.verification.reasons || []).join('+')}`])) }, null, 1));
