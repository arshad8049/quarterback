#!/usr/bin/env node
// KAN-114 10720 (U2): the bounded NO-MODEL qualification driver used by .github/workflows/u2-qualify.yml. NOT RUN YET.
// CI only (GITHUB_ACTIONS=true, U2_CI_RUN=1); refuses if any credential-like variable is set. Never calls a model.
//
//   --plan [--request=<file>]          validate the request against bench/opus-pilot/u2/approvals.json and the committed
//                                      U2 screen order (lib/pilot/u2-qualify.js); writes tasks=<json> to $GITHUB_OUTPUT
//   --task=<key> --repo= --store= --images= --u2-images= --out=
//                                      one task, on QB's real runSandboxed path with the U2 agent image (both arms' image)
//                                      and the unchanged kan117 tools/proxy images:
//                                        1 starting code (base, one commit)            4 agent input (briefing hash, no remotes)
//                                        2 deps: UNCHANGED deps-root-scripts-v1 install for this base only
//                                        2b offline pattern-B build: exactly `npm run build`, pinned scripts, --network none,
//                                           no credentials; must leave no tracked/untracked change
//                                        2c the task's own test command on the base (repo config, recorded as is)
//                                        2d Chromium sandbox probe (no sandbox-disabling flag)
//                                        2e QB Karma research channel on the base (sandbox ON unless the named exception
//                                           is approved); only verdict, counts and an identity-set hash leave the runner
//                                      writes qualify-<key>.json in the arm-A shape (+ a `u2` block) for the sanitizer;
//                                      grader calibration (3) is grade.mjs in the same job
//   --summarize --pub=<dir>            read the sanitized per-task records, apply freezeFirstSix (committed order),
//                                      write u2-freeze.json; checklists are NOT authored here
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a ? (a.includes('=') ? a.slice(k.length + 3) : true) : null; };
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.U2_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const Q = require(path.join(ROOT, 'lib/pilot/u2-qualify.js'));
const RB = require(path.join(ROOT, 'lib/research/u2-root-build.js'));
const APPROVALS = readJson(path.join(HERE, 'approvals.json'));
const ALLOW = readJson(path.join(HERE, 'root-build-allow.json'));
RB.validateRootBuildAllow(ALLOW);
const PLAN = readJson(path.join(ROOT, 'bench/opus-pilot/kan114-six-task-proposal.json'));
const SCOPE = Q.u2Scope(PLAN, ALLOW);

if (arg('plan')) {
  const reqFile = typeof arg('request') === 'string' ? arg('request') : path.join(HERE, 'qualify-request.txt');
  let text;
  try { text = fs.readFileSync(reqFile, 'utf8'); } catch { console.error(`refusing: no request file ${path.relative(ROOT, reqFile)}`); process.exit(1); }
  let r;
  try { r = Q.validateRequest(text, { approvals: APPROVALS, screen: SCOPE.screen }); } catch (e) { console.error(`refusing: ${e.message}`); process.exit(1); }
  const line = `tasks=${JSON.stringify(r.tasks)}\nimages_run=${r.images_run}\nimage_digest=${r.image_digest}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim());
  process.exit(0);
}

if (arg('summarize')) {
  const pub = arg('pub');
  const results = {};
  for (const key of SCOPE.screen) {
    const f = path.join(pub, `qualification-${key}.json`);
    if (!fs.existsSync(f)) continue;
    const q = readJson(f); const u = (q.setup && q.setup.u2) || {};
    results[key] = { setup: q.setup && q.setup.qualified_setup === 'pending_calibration', agent_input: Boolean(u.agent_input_ok),
      calibration: Boolean(q.calibration && q.calibration.gates_passed === true), visible_channel: Boolean(u.visible_channel_ok),
      reason: q.failure ? `${q.failure.where}: ${q.failure.why}` : (!u.visible_channel_ok ? `visible channel: ${(u.karma && u.karma.reasons || []).join(',') || 'not run'}` : undefined) };
  }
  const freeze = Q.freezeFirstSix(SCOPE.screen, results);
  const out = { schema: 'qb-kan114-u2-freeze/1', qb_commit: process.env.GITHUB_SHA || null, screen: SCOPE.screen, not_screened: SCOPE.not_screened, results, ...freeze };
  fs.writeFileSync(path.join(pub, 'u2-freeze.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`::notice title=u2-qualify::status=${freeze.status} frozen=${JSON.stringify(freeze.frozen)} shortfall=${freeze.shortfall ?? 'n/a'} env_failures=${freeze.environment_failures.length} checklists_authored=0`);
  process.exit(0);
}

// ── one task ──
const key = arg('task'); const repo = arg('repo'); const store = arg('store'); const imagesDir = arg('images'); const u2Dir = arg('u2-images'); const outDir = arg('out');
if (!key || !repo || !store || !imagesDir || !u2Dir || !outDir) { console.error('usage: u2-qualify.mjs --task= --repo= --store= --images= --u2-images= --out='); process.exit(2); }
if (!SCOPE.screen.includes(key)) { console.error(`refusing: ${key} is not in the U2 screen`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const entry = ALLOW.entries.find((e) => e.key === key);

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { hardened, TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { armABriefing } = require(path.join(ROOT, 'lib/pilot/arm-a.js'));
const K = require(path.join(ROOT, 'lib/research/karma-channel.js'));
const V = require(path.join(ROOT, 'lib/research/karma-report.js'));

const tasks = readJson(path.join(ROOT, 'bench/opus-pilot/arm-a-grader-tasks.json')).tasks;
const t = tasks[key];
const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === t.task_id);
const agentRow = row('agent'); const vaultRow = row('vault');
const rec = { schema: 'qb-arm-a-qualify/1', task: key, task_id: t.task_id, instance_id: t.instance_id, role: `u2 screen ${SCOPE.screen.indexOf(key) + 1}`, qb_commit: process.env.GITHUB_SHA || null };
const u2 = { schema: 'qb-kan114-u2-qualify/1', rule: RB.RULE, agent_input_ok: false, visible_channel_ok: false };
rec.u2 = u2;
const fail = (where, why) => { if (rec.qualified_setup !== false) { rec.qualified_setup = false; rec.setup_failure = { where, why }; } };
const finish = () => {
  if (rec.qualified_setup !== false) rec.qualified_setup = 'pending_calibration';
  fs.writeFileSync(path.join(outDir, `qualify-${key}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  console.log(JSON.stringify({ task: key, qualified_setup: rec.qualified_setup, failure: rec.setup_failure || null, u2: { build: u2.build, karma: u2.karma && { verdict: u2.karma.verdict, counts: u2.karma.counts }, sandbox_probe: u2.sandbox_probe } }, null, 1));
  process.exit(0);
};

// 1 starting code
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
rec.starting_code = { head: git('rev-parse', 'HEAD'), commits: Number(git('rev-list', '--all', '--count')), tree: git('rev-parse', 'HEAD^{tree}') };
rec.starting_code.ok = rec.starting_code.head === t.base && rec.starting_code.commits === 1 && rec.starting_code.tree === entry.base_tree;
if (!rec.starting_code.ok) { fail('starting_code', 'checkout is not the pinned base (commit + tree) with one commit'); finish(); }

// 2b (host side, before any container): the base package.json must match every reviewed pin
const pkgText = execFileSync('git', ['-C', repo, 'show', 'HEAD:package.json'], { encoding: 'utf8' });   // exact bytes (no trim)
const pinProblems = RB.pinnedBuildProblems(entry, pkgText);
u2.build_pins = { ok: pinProblems.length === 0, problems: pinProblems };
if (pinProblems.length) { fail('coding_env', `pattern-B build pins: ${pinProblems.join('; ')}`); finish(); }
const lock = JSON.parse(git('show', 'HEAD:package-lock.json'));
const lockVer = (n) => (lock.packages && lock.packages[`node_modules/${n}`] && lock.packages[`node_modules/${n}`].version) || null;
const envRec = { schema: K.SCHEMA, task: key, runner: K.RUNNER, karma_version: lockVer('karma'), karma_chrome_launcher_version: lockVer('karma-chrome-launcher'),
  repo_config: 'karma.conf.js', files_grep: null, env: { COVERAGE: 'false', BABEL_NO_MODULES: 'true' }, timeout_s: 900,
  browser: { launcher: K.LAUNCHER, sandbox: 'on' } };
try { K.validateKarmaEnv(envRec); } catch (e) { fail('coding_env', e.message); finish(); }
u2.env_record = envRec;

// 4 agent input
let b = null;
try { b = armABriefing(agentRow, vaultRow); rec.agent_input = { briefing_sha256: b.sha256, fields_shown: b.fields_shown, note: b.note, leak_findings: 0 }; }
catch (e) { rec.agent_input = { error: e.message }; fail('agent_input', e.message); finish(); }

// the task's own test command (official markers), base tree only
const ev = String(vaultRow.eval_script || '');
const m = /^: '>>>>> Start Test Output'\n([\s\S]*?)\n: '>>>>> End Test Output'$/m.exec(ev);
const testCmd = m ? m[1].trim() : null;
if (!testCmd || testCmd.includes('\n')) { fail('coding_env', 'no single test command between the official markers'); finish(); }

// images: kan117 tools + proxy (unchanged), the U2 agent image (QB_SANDBOX_AGENT_IMAGE)
const prov = readJson(path.join(imagesDir, 'image-provenance.json'));
const u2prov = readJson(path.join(u2Dir, 'u2-image-provenance.json'));
if (AGENT_IMAGE !== u2prov.image.ref) { console.error('refusing: QB_SANDBOX_AGENT_IMAGE is not the loaded U2 image'); process.exit(3); }
const ids = {};
for (const [ref, want] of [[AGENT_IMAGE, u2prov.image.id], [TOOLS_IMAGE, prov.images.tools.id], [PROXY_IMAGE, prov.images.proxy.id]]) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== want) { console.error(`${ref}: not the loaded image`); process.exit(3); }
  ids[ref] = want;
}
u2.images = { agent: u2prov.image.id, tools: prov.images.tools.id, proxy: prov.images.proxy.id };

const kHost = fs.mkdtempSync(path.join(os.tmpdir(), 'u2-karma-'));
fs.chmodSync(kHost, 0o777);
const nonce = crypto.randomBytes(16).toString('hex');
const outName = `${crypto.randomBytes(8).toString('hex')}.jsonl`;
const inv = K.karmaInvocation(envRec, { nonce, outPath: `/qbout/${outName}`, researchDir: '/qb/research', repoRoot: '/work', approvals: APPROVALS });
const plan = RB.offlineBuildPlan(entry);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const envArgs = (o) => Object.entries(o).map(([k, v]) => `${k}=${q(v)}`).join(' ');
let probe = null; let karmaStartedAt = null;
const stage = async (ws, _egress, { waitTimeoutMs, briefing }) => {
  karmaStartedAt = Date.now();
  const script = [
    'g() { git -c safe.directory="*" "$@"; }',
    'echo "stdin_sha256=$(sha256sum | cut -d" " -f1)" 1>&2',
    'echo "commits=$(g rev-list --all --count) refs=$(g for-each-ref | wc -l) remotes=$(g remote | wc -l)" 1>&2',
    // 2b offline build: fixed argv + fixed npm env, network none (container), no credentials (none passed)
    `s=$(date +%s); ( env ${envArgs(plan.env)} timeout ${plan.timeout_s} ${plan.argv.join(' ')} ) > /tmp/qbx-build.log 2>&1; bec=$?; e=$(date +%s)`,
    'echo "build_exit=$bec build_seconds=$((e-s)) tracked_changed=$(g status --porcelain | grep -vc "^??") untracked=$(g status --porcelain | grep -c "^??")" 1>&2',
    // 2d Chromium sandbox probe: no sandbox-disabling flag
    'timeout 60 chromium --headless=new --disable-gpu --disable-dev-shm-usage --dump-dom "data:text/html,<p>qb</p>" > /tmp/qbx-dom 2> /tmp/qbx-chr; cec=$?',
    'echo "chromium_exit=$cec chromium_rendered=$(grep -c "<p>qb</p>" /tmp/qbx-dom) no_usable_sandbox=$(grep -ciE "no usable sandbox|sandbox.*(fail|unavailable)" /tmp/qbx-chr)" 1>&2',
    // 2e QB Karma research channel (QB wrapper + reporter, read-only mount); report written to the host-mounted /qbout
    `( env -i PATH="$PATH" HOME=/tmp/home ${envArgs(inv.env)} timeout ${envRec.timeout_s} ${inv.argv.map(q).join(' ')} ) > /tmp/qbx-karma.log 2>&1; kec=$?`,
    'echo "karma_exit=$kec" 1>&2',
    // 2c the task's own test command (repository config, as the grader and the agent would run it)
    `start=$(date +%s); ( ${testCmd} ) > /tmp/qbx-test.log 2>&1; ec=$?; end=$(date +%s)`,
    'echo "test_exit=$ec test_seconds=$((end-start))" 1>&2',
    'echo "karma_pass=$(grep -c "✔" /tmp/qbx-test.log) karma_fail=$(grep -c "✖" /tmp/qbx-test.log) karma_browser_started=$(grep -c "Starting browser" /tmp/qbx-test.log)" 1>&2',
    'echo "missing_browser=$(grep -ciE "no binary for|cannot start chrome|failed to launch|chrome_bin" /tmp/qbx-test.log) missing_module=$(grep -ciE "cannot find module|command not found|ERR_MODULE_NOT_FOUND" /tmp/qbx-test.log)" 1>&2',
    'node -e \'const fs=require("fs");const l=JSON.parse(fs.readFileSync("package-lock.json","utf8"));let n=0,ok=0,miss=0,bad=0,opt=0;for(const [k,v] of Object.entries(l.packages||{})){if(!k)continue;n++;let p;try{p=JSON.parse(fs.readFileSync(k+"/package.json","utf8"))}catch{if(v.optional){opt++;continue}miss++;continue}if(p.version===v.version)ok++;else bad++}console.error("lock_pkgs="+n+" lock_match="+ok+" lock_missing="+miss+" lock_mismatch="+bad+" lock_optional_absent="+opt)\' 1>&2 || echo "lock_check=failed" 1>&2',
  ].join('\n');
  const r = await D.runStage(`${ws.runId}-agent`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), '-v', `${ws.runId}-deps:/work/node_modules:ro`,
    '-v', `${path.join(ROOT, 'sandbox', 'research')}:/qb/research:ro`, '-v', `${kHost}:/qbout:rw`,
    '-e', 'HOME=/tmp/home', '-e', 'CI=true', '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700', '-w', '/work', '--entrypoint', 'bash', AGENT_IMAGE, '-c', script,
  ], { input: Buffer.from(briefing), waitTimeoutMs });
  const kv = {};
  for (const l of String(r.stderr || '').split('\n')) for (const mm of l.matchAll(/([a-z_0-9]+)=(\S*)/g)) kv[mm[1]] = mm[2];
  probe = kv;
  return r;
};
const release = D.bindImages(ids);
const t0 = Date.now();
const r = await runSandboxed({ repoPath: repo, briefing: b.briefing, agentStage: stage, verify: false, requireMemoryCheck: true,
  researchRootScripts: RB.installEntries({ entries: [entry] }), deadlines: { agent: 40 * 60_000 } });
const launches = release();
const n = (k) => (probe && /^\d+$/.test(probe[k] || '') ? Number(probe[k]) : null);
rec.coding_env = {
  status: r.status, wall_ms: Date.now() - t0, deps: r.sandbox && r.sandbox.deps, agent_stage: r.sandbox && r.sandbox.stages && r.sandbox.stages.agent,
  capture: r.sandbox && r.sandbox.capture && r.sandbox.capture.verdict, test_command_sha256: sha(testCmd), test_exit: n('test_exit'), test_seconds: n('test_seconds'),
  results: { tap_ok: 0, tap_not_ok: 0, karma_pass: n('karma_pass'), karma_fail: n('karma_fail'), karma_browser_started: n('karma_browser_started') },
  signals: { missing_browser: n('missing_browser'), missing_module: n('missing_module') },
  launches: launches.length, distinct_images: [...new Set(launches.map((l) => l.image))],
  root_scripts: (r.sandbox && r.sandbox.deps && r.sandbox.deps.root_scripts) || null,
  deps_check: (r.sandbox && r.sandbox.deps && r.sandbox.deps.check_state) || null,
  dependency_graph: { lock_pkgs: n('lock_pkgs'), lock_match: n('lock_match'), lock_missing: n('lock_missing'), lock_mismatch: n('lock_mismatch'), lock_optional_absent: n('lock_optional_absent') },
};
rec.coding_env.existing_failures = rec.coding_env.results.karma_fail || 0;
rec.agent_input = { ...rec.agent_input, stdin_matches: !!probe && probe.stdin_sha256 === b.sha256, workspace_commits: n('commits'), workspace_refs: n('refs'), workspace_remotes: n('remotes') };
u2.agent_input_ok = rec.agent_input.stdin_matches && rec.agent_input.workspace_commits === 1 && rec.agent_input.workspace_remotes === 0;
u2.build = { exit: n('build_exit'), seconds: n('build_seconds'), tracked_changed: n('tracked_changed'), untracked: n('untracked'),
  tree_problems: n('tracked_changed') === null || n('untracked') === null ? ['no tree state recorded']
    : [...(n('tracked_changed') ? [`the build changed ${n('tracked_changed')} tracked file(s)`] : []), ...(n('untracked') ? [`the build left ${n('untracked')} untracked, non-ignored file(s)`] : [])] };
u2.sandbox_probe = { sandbox_disabled: false, exit: n('chromium_exit'), rendered: n('chromium_rendered') === 1, no_usable_sandbox_message: (n('no_usable_sandbox') || 0) > 0,
  started_with_sandbox: n('chromium_exit') === 0 && n('chromium_rendered') === 1 };
let reportText = null;
try { reportText = fs.readFileSync(path.join(kHost, outName), 'utf8'); } catch { reportText = null; }
const kv = V.validateKarmaRun({ reportText, exitCode: n('karma_exit'), startedAtMs: karmaStartedAt || t0, nonce, karmaVersion: envRec.karma_version });
u2.karma = { verdict: kv.verdict, reasons: kv.reasons, counts: kv.counts, identity_set_sha256: kv.identity_set_sha256, exit: n('karma_exit'), launcher_flags: JSON.parse(inv.env.QB_KARMA_FLAGS), sandbox: envRec.browser.sandbox };
u2.visible_channel_ok = ['passed', 'failed'].includes(kv.verdict);
fs.rmSync(kHost, { recursive: true, force: true });

const g = rec.coding_env.dependency_graph;
const ran = (rec.coding_env.results.karma_pass || 0) + (rec.coding_env.results.karma_fail || 0) > 0;
if (!r.sandbox || !r.sandbox.deps || r.sandbox.deps.status !== 'ready') fail('coding_env', `QB deps stage: ${r.sandbox && r.sandbox.deps ? `${r.sandbox.deps.status} ${r.sandbox.deps.reason || ''}`.trim() : r.status}`);
else if (!rec.coding_env.root_scripts) fail('coding_env', 'deps-root-scripts-v1 was not applied');
else if (!(g.lock_pkgs > 0) || g.lock_missing !== 0 || g.lock_mismatch !== 0) fail('coding_env', 'the installed tree differs from the pinned lockfile');
else if (u2.build.exit !== 0) fail('coding_env', `pattern-B offline build failed (exit ${u2.build.exit})`);
else if (u2.build.tree_problems.length) fail('coding_env', `pattern-B offline build: ${u2.build.tree_problems.join('; ')}`);
else if (!probe || probe.test_exit === undefined) fail('coding_env', `the workspace probe did not complete (${r.status})`);
else if (!ran) fail('coding_env', `the task's test command produced no test results (exit ${probe.test_exit}${n('missing_browser') ? ', no usable browser' : ''}${n('missing_module') ? ', missing module/command' : ''})`);
else if (!u2.agent_input_ok) fail('agent_input', 'the agent stage did not receive exactly the briefing in a one-commit workspace without remotes');
// the QB visible channel is recorded separately (freeze criterion `visible_channel`), not as a setup failure
const cands = readJson(path.join(ROOT, 'bench/public/manifest/candidates.json')).tasks;
const c = cands.find((x) => x.task_id === t.task_id);
rec.qb_compatibility = c ? { status: c.classification.status, reasons: c.classification.reasons, established: false } : { status: 'unknown', established: false };
finish();
