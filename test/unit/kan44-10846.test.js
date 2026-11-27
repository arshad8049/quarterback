/**
 * KAN-44 senior review 10846. DUMMY values only; Docker is a FAKE binary that logs every command (no real container,
 * no real credential, Docker settings never touched).
 *   1. credential-reading container operations outside a run (`qb auth login`, the `qb patch` recheck) refuse on
 *      live-restore enabled/unknown BEFORE any container is created; status, logout and cleanup stay available;
 *   2. salted fingerprints stay local evidence: not printed, not in the hold event;
 *   3. an unbound recheck refuses export, asks for a new run, and never claims the patch was sanitised;
 *   4. a security hold is never presented as PASS/VERIFIED: the overall verdict is unresolved and the report says
 *      security-held, export denied; the individual test evidence is kept and replays; benchmark trials on hold are
 *      attrition (never scored), with the patch bytes kept out of the experiment records;
 *   5. new work is not admitted while an unresolved earlier run still has a running workload (Docker returned,
 *      supervisor not yet done, or concurrent startup); it proceeds once Docker confirms nothing of it runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-k44-10846-'));
const LOG = path.join(dir, 'docker.log');
const bin = path.join(dir, 'docker');
fs.writeFileSync(bin, [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
  'case "$1" in',
  '  version) echo 28.0.0-fake; exit 0 ;;',
  '  info) case "$FAKE_LR" in true) echo true ;; false) echo false ;; *) exit 1 ;; esac; exit 0 ;;',
  '  ps) case "$*" in *"qb.run=$FAKE_RUNNING_RUN"*status=running*) [ -n "$FAKE_RUNNING_RUN" ] && echo c0ffee ;; esac;',
  '      [ "$FAKE_PS_FAIL" = 1 ] && exit 1; exit 0 ;;',
  'esac',
  'exit 0', ''].join('\n'), { mode: 0o755 });
process.env.QB_DOCKER_BIN = bin;
process.env.FAKE_DOCKER_LOG = LOG;
process.env.QB_OLLAMA_URL = 'http://192.0.2.1:11434';
process.env.QB_AUTH_VOLUME = 'qb-k44-10846-fake-auth';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../../run/store');
const P = require('../../lib/sandbox/protocol');
const { approve } = require('../../intent/contract-state');
const S = require('../../lib/credential-scan');
const C = require('../../lib/sandbox/credential-check');

const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const LAUNCH = /^(run|create|start|volume create|network create|build)\b/;
beforeEach(() => { fs.rmSync(LOG, { force: true }); delete process.env.FAKE_RUNNING_RUN; delete process.env.FAKE_PS_FAIL; process.env.FAKE_LR = 'false'; });

async function captureStderr(fn) {
  const errs = []; const ew = process.stderr.write; process.stderr.write = (x) => { errs.push(String(x)); return true; };
  try { return { value: await fn(), err: errs.join('') }; } finally { process.stderr.write = ew; }
}

describe('1. auth and patch-recheck containers refuse on live-restore enabled/unknown; status, logout and cleanup stay', () => {
  for (const lr of ['true', 'fail']) {
    test(`qb auth login (${lr}): refused before any container or volume is created`, async () => {
      process.env.FAKE_LR = lr;
      const { value, err } = await captureStderr(() => require('../../lib/sandbox/cli').main(['auth', 'login']));
      assert.notEqual(value, 0);
      assert.match(err, /live_restore_(enabled|unknown)/);
      assert.deepEqual(log().filter((l) => LAUNCH.test(l)), []);
    });
    test(`qb patch recheck (${lr}): Mode S recheck refused before its container is created`, async () => {
      process.env.FAKE_LR = lr;
      const { recheckExact } = require('../../lib/sandbox/cli');
      const binding = { schema: 'qb-credential-binding/1', mode: 'S', salt: 'ab'.repeat(16), fingerprints: ['1'.repeat(64)] };
      const r = await recheckExact(Buffer.from('x'), { mode: 'S', status: 'error', binding }, { image: 'tools' });
      assert.equal(r.status, 'blocked'); assert.match(r.reason, /live_restore_/);
      assert.deepEqual(log().filter((l) => LAUNCH.test(l)), []);
    });
  }
  test('qb auth status and logout still run with live-restore enabled (never blocked by the gate)', async () => {
    process.env.FAKE_LR = 'true';
    const cli = require('../../lib/sandbox/cli');
    const st = await captureStderr(() => cli.main(['auth', 'status']));
    assert.doesNotMatch(st.err, /live_restore/);
    // The fake Docker cannot run the egress proxy, so logout fails later on; what matters is that it was not refused
    // by the gate and went on to start its containers.
    let thrown = null;
    const lo = await captureStderr(() => cli.main(['auth', 'logout']).catch((e) => { thrown = e; return 1; }));
    assert.doesNotMatch(`${lo.err} ${thrown && thrown.message}`, /live_restore/);
    assert.ok(log().some((l) => /^(network create|run -d)/.test(l)), 'logout went on to start its containers');
  });
  test('qb patch with a Mode S recheck refused: export refused with the live-restore reason', async () => {
    process.env.FAKE_LR = 'true';
    const raw = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n');
    const ev = { ...S.scanPatch(raw), status: 'incomplete', exact: { mode: 'S', status: 'error', binding: { schema: 'qb-credential-binding/1', mode: 'S', salt: 'ab'.repeat(16), fingerprints: ['1'.repeat(64)] } } };
    const r = makeRun(raw, ev);
    const p = await patchCmd(r, {});
    assert.equal(p.code, 1); assert.match(p.err, /live_restore_enabled/);
  });
});

function makeRun(raw, scan, verdict = 'pass') {
  const d = fs.mkdtempSync(path.join(dir, 'run-')); const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  const runsDir = path.join(d, 'runs');
  const run = store.createRun({ kind: 'qb', request: 'x', repoPath: repo, runsDir });
  run.startAttempt({ attempt: 1 });
  run.finishAttempt(1, { execution: { status: 'completed', changes: [], sandbox: { credential_scan: scan } }, report: { verdict } });
  run.artifact('a1-patch-raw', raw, { ext: 'bin' });
  run.finish('UNRESOLVED', {});
  return { dir: d, runsDir, id: run.id };
}
async function patchCmd(r, deps) {
  const out = await captureStderr(() => require('../../lib/sandbox/cli').patch([r.id, '--out', path.join(r.dir, 'o', 'p.patch')], { loadRun: (id) => store.loadRun(id, r.runsDir), env: {}, ...deps }));
  return { code: out.value, err: out.err };
}

describe('2 and 3. fingerprints stay local; an unbound recheck asks for a new run without claiming sanitisation', () => {
  const salt = 'cd'.repeat(16); const own = 'plain-dummy-own-credential-0123456789';
  const binding = { schema: 'qb-credential-binding/1', mode: 'K', variable: 'ANTHROPIC_API_KEY', salt, fingerprints: [C.fingerprint(salt, own)] };
  test('the hold event, the hold message and qb patch output carry no fingerprint or salt', async () => {
    const { runPipeline } = require('../../lib/qb-pipeline');
    const d = fs.mkdtempSync(path.join(dir, 'pipe-'));
    const run = store.createRun({ kind: 'qb', request: 'x', repoPath: d, runsDir: path.join(d, 'runs') });
    const scan = { status: 'incomplete', findings: [], exact: { mode: 'K', status: 'error', binding } };
    const shown = [];
    await runPipeline({ contract: { goal: 'g', acceptance_criteria: [] }, repoPath: d, agent: 'claude-code', maxRetries: 1, run, memory: null,
      hooks: { credentialHold: (s) => shown.push(...S.holdMessage(s)) },
      deps: { buildContext: async () => ({ relevant_files: [], symbol_map: {} }), refreshContext: async (c) => ({ context: c, refresh: {} }),
        orchestrate: async () => ({ id: 'e', status: 'completed', changes: [], diff: 'd', sandbox: { run_id: 'r', stages: {}, credential_scan: scan } }),
        verify: async () => ({ verdict: 'unresolved', criteria_results: [], repair_hints: [], failures: [] }) } });
    const ev = store.readEvents(run).find((e) => e.type === 'credential.hold');
    assert.ok(ev);
    const text = JSON.stringify(ev) + shown.join('\n');
    assert.ok(!text.includes(salt) && !text.includes(binding.fingerprints[0]), 'no salt or fingerprint in the event or on screen');
    assert.equal(ev.data.exact.status, 'error', 'the event still says what happened'); assert.equal(ev.data.exact.bound, true);
  });
  test('qb patch, recheck unbound: refused, a new run asked for, the stored patch called unchanged and NOT sanitised; no fingerprint', async () => {
    const raw = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n');
    const ev = { ...S.scanPatch(raw), status: 'incomplete', exact: { mode: 'K', status: 'error', binding } };
    const p = await patchCmd(makeRun(raw, ev), { env: { ANTHROPIC_API_KEY: 'plain-dummy-replaced-credential-987654' } });
    assert.equal(p.code, 1);
    assert.match(p.err, /run the task again/i);
    assert.match(p.err, /not been sanitised|has not been sanitized/);
    assert.match(p.err, /unchanged/);
    assert.doesNotMatch(p.err, /\b(safe to|clean)\b/i);
    assert.ok(!p.err.includes(salt) && !p.err.includes(binding.fingerprints[0]));
  });
});

describe('4. a security hold is never presented as PASS/VERIFIED', () => {
  const { aggregate, inputFromReport } = require('../../verify/verdict');
  const passing = { rules: 6, oracleApproved: true, policyEffect: 'ok', hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null,
    executionStatus: 'completed', unsupportedChanges: false, verification: { status: 'ran', outcome: 'passed' } };
  test('aggregate: what would be a pass is unresolved under a hold (finding or incomplete); without one it is still pass', () => {
    assert.equal(aggregate(passing).verdict, 'pass');
    for (const h of ['finding', 'incomplete']) assert.equal(aggregate({ ...passing, securityHold: h }).verdict, 'unresolved', h);
    assert.equal(aggregate({ ...passing, executionStatus: 'timeout', securityHold: 'finding' }).verdict, 'error', 'an execution error stays an error');
  });
  test('verify(): verdict unresolved, report.security_hold says export denied, test evidence kept, and the stored input replays the same verdict', async () => {
    const { verify } = require('../../verify/verifier');
    const contract = approve({ id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'x', met: null }], clarifying_question: null, scope: { allowed_changes: ['**'] },
      checks: [] }, { via: 'test' });
    const report = (pass) => [{ type: 'qb:start', format: 'qb-node-test-events/1' }, { type: pass ? 'test:pass' : 'test:fail', name: 't', nesting: 0, path: [], file: '/verify/t.test.js', kind: 'test', skip: false, todo: false },
      { type: 'test:summary', file: null, counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, success: true }, { type: 'qb:end' }].map((e) => JSON.stringify(e)).join('\n') + '\n';
    const execution = { status: 'completed', diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n', changes: [{ file: 'a.js', status: 'M', additions: 1, deletions: 1 }],
      sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, report: report(true), report_error: null, output: '' }, credential_scan: { status: 'finding', findings: [{ kind: 'github_token', count: 1, file_index: 1, where: 'content' }] } } };
    const rep = await verify(contract, null, execution, { repoPath: '/repo' });
    assert.equal(rep.verdict, 'unresolved');
    assert.deepEqual(rep.security_hold, { status: 'finding', export: 'denied' });
    assert.ok(rep.test_outcome, 'the individual test evidence is kept');
    assert.equal(execution.sandbox.verification.state, 'completed', 'original test evidence is not rewritten');
    assert.equal(aggregate(inputFromReport(rep, execution)).verdict, 'unresolved', 'replay reproduces it');
    const clean = await verify(contract, null, { ...execution, sandbox: { ...execution.sandbox, credential_scan: { status: 'clean', findings: [] } } }, { repoPath: '/repo' });
    assert.equal(clean.security_hold, undefined);
  });
  test('the qb.js summary line for a held run: UNRESOLVED, security-held, export denied', () => {
    const lines = S.resultLines({ verdict: 'unresolved', security_hold: { status: 'finding', export: 'denied' } });
    assert.match(lines.join('\n'), /UNRESOLVED.*security hold.*export denied/i);
    assert.doesNotMatch(lines.join('\n'), /PASS|VERIFIED/);
    assert.deepEqual(S.resultLines({ verdict: 'pass' }), [], 'nothing extra without a hold');
  });
  test('benchmark: a held trial is attrition, never scored; the patch bytes stay out of the experiment record', () => {
    const Sch = require('../../bench/schemas');
    assert.ok(Sch.TRIAL_STATUSES.includes('security_hold'));
    const rep = require('../../bench/report');
    assert.ok(rep.ATTRITION.includes('security_hold'));
    assert.equal(rep.categorize({ status: 'security_hold', artifacts: {} }), 'security_hold');
    const { trialArtifacts } = require('../../bench/experiment-run');
    const a = trialArtifacts({ patch: 'diff --git a/x b/x\n+SECRETISH\n', credential_hold: 'finding' }, { u: 1 }, { r: 1 });
    assert.equal(a['patch.diff'], undefined);
    assert.equal(a['patch.withheld.json'].reason, 'security_hold: finding');
    assert.equal(a['patch.withheld.json'].patch_sha256, crypto.createHash('sha256').update('diff --git a/x b/x\n+SECRETISH\n').digest('hex'));
    assert.ok(!JSON.stringify(a).includes('SECRETISH'));
    assert.equal(trialArtifacts({ patch: 'p' }, {}, {})['patch.diff'], 'p', 'a trial without a hold keeps its patch');
  });
});

describe('5. new work is not admitted while an unresolved earlier run still has a running workload', () => {
  const { runSandboxed } = require('../../lib/sandbox/pipeline');
  /** A state dir with one open earlier run: no terminal state, enforcement unresolved, its supervisor alive (this process). */
  function stateWithOpenRun(id) {
    const sd = fs.mkdtempSync(path.join(dir, 'state-'));
    const rd = path.join(sd, 'runs', id); fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ run_id: id, cli: { pid: 999999, start: 'gone' }, supervisor: P.identity(process.pid) }));
    fs.writeFileSync(path.join(rd, 'enforcement.json'), JSON.stringify({ state: 'unresolved', unresolved: true, reason: 'enforcement_unconfirmed: docker_unavailable' }));
    return sd;
  }
  test('Docker has returned but the earlier workload still runs: BLOCKED unresolved_workload, nothing created, the lock released', async () => {
    const sd = stateWithOpenRun('qb-old-1');
    process.env.FAKE_RUNNING_RUN = 'qb-old-1';
    const r = await runSandboxed({ repoPath: dir, briefing: 'x', stateDir: sd });
    assert.equal(r.status, 'blocked', JSON.stringify(r));
    assert.match(r.reason, /^unresolved_workload: .*qb-old-1/);
    assert.deepEqual(log().filter((l) => LAUNCH.test(l)), []);
    assert.ok(!fs.existsSync(path.join(sd, 'admission.lock')), 'admission released: the user is not blocked forever');
  });
  test('Docker cannot say whether it still runs: BLOCKED (unknown is not "nothing running")', async () => {
    const sd = stateWithOpenRun('qb-old-2');
    process.env.FAKE_PS_FAIL = '1';
    const r = await runSandboxed({ repoPath: dir, briefing: 'x', stateDir: sd });
    assert.equal(r.status, 'blocked'); assert.match(r.reason, /^unresolved_workload_unknown: /);
  });
  test('concurrent startup: two runs at once while the earlier workload runs: neither starts anything', async () => {
    const sd = stateWithOpenRun('qb-old-3');
    process.env.FAKE_RUNNING_RUN = 'qb-old-3';
    const rs = await Promise.all([runSandboxed({ repoPath: dir, briefing: 'x', stateDir: sd }), runSandboxed({ repoPath: dir, briefing: 'x', stateDir: sd })]);
    for (const r of rs) { assert.equal(r.status, 'blocked'); assert.match(r.reason, /^(unresolved_workload|run_in_progress)/); }
    assert.deepEqual(log().filter((l) => LAUNCH.test(l)), []);
  });
  test('once Docker confirms nothing of the earlier run runs, new work is admitted (the guard lets it through)', async () => {
    const { unresolvedWorkloads } = require('../../lib/sandbox/admission');
    const sd = stateWithOpenRun('qb-old-4');
    assert.deepEqual(await unresolvedWorkloads(path.join(sd, 'runs')), { running: [], unknown: [] });
    process.env.FAKE_RUNNING_RUN = 'qb-old-4';
    assert.deepEqual(await unresolvedWorkloads(path.join(sd, 'runs')), { running: ['qb-old-4'], unknown: [] });
    // a run with a committed terminal state is not open
    P.commitTerminal(path.join(sd, 'runs', 'qb-old-4'), 'infra_error', 'supervisor', 'test');
    assert.deepEqual(await unresolvedWorkloads(path.join(sd, 'runs')), { running: [], unknown: [] });
  });
});
