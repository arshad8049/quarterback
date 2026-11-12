/**
 * KAN-111 review 10551: runner-level gates of grade.mjs, exercised end to end with a fake docker CLI and a
 * fake grader (test/fixtures/kan111). Nothing here runs Docker, the SWE-bench harness or any task code.
 * The runner accepts fixtures only with --approved-by=FIXTURE and marks the summary fixture_mode.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GRADE = path.join(ROOT, 'bench', 'public', 'grader', 'immutable-offline-v1', 'grade.mjs');
const FX = path.join(__dirname, '..', 'fixtures', 'kan111');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EVAL = "set -uxo pipefail\ncd /testbed\nnpm run build\n: '>>>>> Start Test Output'\n(npx jest __tests__/Range.ts --verbose) | cat\n: '>>>>> End Test Output'\n";

function setup(scenario) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan111r-'));
  const store = path.join(d, 'store'); fs.mkdirSync(path.join(store, 'controller'), { recursive: true }); fs.mkdirSync(path.join(store, 'vault'), { recursive: true });
  const row = { task_id: 'qbt_fixture', instance_id: 'immutable-js__immutable-js-2006' };
  fs.writeFileSync(path.join(store, 'controller', 'swe-bench-multilingual.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), JSON.stringify({ ...row, eval_script: EVAL, patch: 'diff --git a/src/a.js b/src/a.js\n', FAIL_TO_PASS: ['f'], PASS_TO_PASS: ['p'] }) + '\n');
  const fixture = { store, tasks: { 2006: { task_id: 'qbt_fixture', instance_id: 'immutable-js__immutable-js-2006', base: 'base', image: 'fixture/image@sha256:' + '0'.repeat(64),
    eval_sha256: sha(EVAL), test_files: ['__tests__/Range.ts'], a1_build: 'npm run build:clean && npm run build:dist' } } };
  fs.writeFileSync(path.join(d, 'fixture.json'), JSON.stringify(fixture));
  fs.writeFileSync(path.join(d, 'scenario.json'), JSON.stringify(scenario));
  return d;
}
// A tripwire `docker` placed FIRST on PATH: if anything ever reaches a real-looking docker, the test fails.
function tripwire(d) {
  const bin = path.join(d, 'tripwire-bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(d, 'LIVE-DOCKER-CALLED'))}\nexit 1\n`); fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_CALLS: path.join(d, 'fake-calls.txt') };
}
function run(scenario, extra = [], { reps = '1' } = {}) {
  const d = setup(scenario);
  const r = spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=FIXTURE', `--reps=${reps}`, '--fixture-timeout=1', `--out=${path.join(d, 'out')}`, ...extra], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...tripwire(d), QB_KAN111_FIXTURE: path.join(d, 'fixture.json'), QB_KAN111_DOCKER: path.join(FX, 'fake-docker.js'), SWEBENCH_PYTHON: process.execPath,
      QB_KAN111_GRADER: path.join(FX, 'fake-grader.js'), FAKE_DOCKER_SCENARIO: path.join(d, 'scenario.json'), FAKE_BASE: 'base' } });
  const summaryPath = path.join(d, 'out', 'summary.json');
  const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
  const live = fs.existsSync(path.join(d, 'LIVE-DOCKER-CALLED'));
  const fakeCalls = fs.existsSync(path.join(d, 'fake-calls.txt')) ? fs.readFileSync(path.join(d, 'fake-calls.txt'), 'utf8').trim().split('\n').length : 0;
  fs.rmSync(d, { recursive: true, force: true });
  assert.equal(live, false, 'a real docker was invoked');
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary, fakeCalls };
}
const byLabel = (s, l) => s.runs.find((x) => x.label === l);

describe('KAN-111 runner gates (fake docker and grader; no real execution)', () => {
  test('all gates met: exit 0, fixture mode recorded, every expectation satisfied; only the fake docker was called', () => {
    const r = run({});
    assert.ok(r.fakeCalls > 20, 'the fake docker recorded the calls');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.summary.fixture_mode, true);
    assert.equal(r.summary.gates_passed, true);
    for (const x of r.summary.runs) assert.equal(x.expectation_met, true, `${x.label}: ${JSON.stringify(x)}`);
    assert.equal(byLabel(r.summary, 'iso-patch-conflict').outcome, 'patch_apply_failed');
  });
  test('wrong matrix (gold not accepted by the grader) fails the run and the exit code', () => {
    const r = run({ grade: { gold: { accepted: false } } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').expectation_met, false); assert.equal(r.summary.gates_passed, false);
  });
  test('a grader crash is an infrastructure error, not "graded"', () => {
    const r = run({ grade: { empty: { exit: 3 } } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'empty').outcome, 'infra_error');
  });
  test('a malformed grade.json (no acceptance) is an infrastructure error', () => {
    const r = run({ grade: { empty: { raw: { official: {} } } } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'empty').outcome, 'infra_error');
  });
  test('a docker failure is an infrastructure error; later runs still execute and keep their evidence', () => {
    const r = run({ fail: { create: 'empty' } });
    assert.equal(r.status, 1);
    assert.equal(byLabel(r.summary, 'empty').outcome, 'infra_error');
    assert.match(byLabel(r.summary, 'empty').infra_step, /create/);
    assert.equal(byLabel(r.summary, 'gold').outcome, 'graded');
  });
  test('a base mismatch is an infrastructure error', () => {
    const r = run({ baseCheck: { gold: 1 } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'infra_error');
  });
  test('a failed required build step is build_failed, never a qualified replay', () => {
    const r = run({ evalExit: { gold: 97 } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'build_failed'); assert.equal(byLabel(r.summary, 'gold').grade, undefined);
  });
  test('a conflicting patch that unexpectedly applies fails the isolation gate (the zero-byte case never reaches apply: review 10568)', () => {
    const r = run({ apply: { default: 0 } });
    assert.equal(r.status, 1);
    assert.equal(byLabel(r.summary, 'iso-patch-conflict').expectation_met, false);
    assert.equal(byLabel(r.summary, 'iso-empty-patch-file').outcome, 'empty_patch_excluded', 'excluded before apply, whatever the apply step would do');
  });
  test('tamper: proven only when the tamper applied before grading, is absent at the test boundary, and the tested tree matches gold', () => {
    assert.equal(byLabel(run({}).summary, 'iso-test-file-tamper').expectation_met, true);
    const notApplied = run({ markerBefore: { 'iso-test-file-tamper': 0 } });
    assert.equal(byLabel(notApplied.summary, 'iso-test-file-tamper').expectation_met, false, 'a tamper that never applied proves nothing');
    const stillThere = run({ markerTested: { 'iso-test-file-tamper': 1 } });
    assert.equal(byLabel(stillThere.summary, 'iso-test-file-tamper').expectation_met, false);
    const differentTree = run({ testedHash: { default: 'h-gold', 'iso-test-file-tamper': 'h-other' } });
    assert.equal(byLabel(differentTree.summary, 'iso-test-file-tamper').expectation_met, false);
  });
  test('timeout: the deterministic fixture must time out; a fixture that finishes fails the gate', () => {
    const ok = run({ evalSleep: { 'iso-timeout-fixture': 5 } });
    assert.equal(byLabel(ok.summary, 'iso-timeout-fixture').outcome, 'timeout');
    assert.equal(byLabel(ok.summary, 'iso-timeout-fixture').expectation_met, true);
    const fast = run({ evalSleep: { 'iso-timeout-fixture': 0 } });
    assert.equal(byLabel(fast.summary, 'iso-timeout-fixture').expectation_met, false);
  });
  test('fixtures require --approved-by=FIXTURE, and --execute requires an approval', () => {
    const d = setup({});
    // Even if a guard regresses, this test can never reach real Docker or the real grader: fake binaries,
    // a temporary output folder, and an obviously fake approval string (never a real review comment id).
    const safe = { ...process.env, QB_KAN111_DOCKER: path.join(FX, 'fake-docker.js'), SWEBENCH_PYTHON: process.execPath,
      QB_KAN111_GRADER: path.join(FX, 'fake-grader.js'), FAKE_DOCKER_SCENARIO: path.join(d, 'scenario.json') };
    const out = ['--out=' + path.join(d, 'guard-out')];
    assert.equal(spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=NOT-A-REAL-APPROVAL', ...out], { env: { ...safe, QB_KAN111_FIXTURE: path.join(d, 'fixture.json') }, encoding: 'utf8' }).status, 2, 'a fixture needs --approved-by=FIXTURE');
    assert.equal(spawnSync(process.execPath, [GRADE, '--execute', ...out], { env: safe, encoding: 'utf8' }).status, 2, '--execute needs an approval');
    assert.equal(spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=FIXTURE', ...out], { env: safe, encoding: 'utf8' }).status, 2, 'FIXTURE approval without a fixture is refused');
    assert.ok(!fs.existsSync(path.join(d, 'guard-out')), 'a refused run writes nothing');
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('review 10554: a boundary helper failure (eval exit 98) is an infrastructure error, never graded', () => {
    const r = run({ evalExit: { gold: 98 } });
    assert.equal(r.status, 1); const g = byLabel(r.summary, 'gold');
    assert.equal(g.outcome, 'infra_error'); assert.match(g.infra_step, /boundary/); assert.equal(g.grade, undefined);
  });
  test('review 10554: a copied manifest that does not match the emitted hash is an infrastructure error', () => {
    const r = run({ manifestCorrupt: { gold: true } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'infra_error'); assert.match(byLabel(r.summary, 'gold').infra_step, /manifest/);
  });
  test('review 10568: an exactly-empty submitted patch is excluded before any container (no docker calls, never graded)', () => {
    const d = setup({}); const calls = path.join(d, 'fake-calls.txt');
    const r = spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=FIXTURE', '--reps=1', '--fixture-timeout=1', `--out=${path.join(d, 'out')}`], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ...tripwire(d), QB_KAN111_FIXTURE: path.join(d, 'fixture.json'), QB_KAN111_DOCKER: path.join(FX, 'fake-docker.js'), SWEBENCH_PYTHON: process.execPath,
        QB_KAN111_GRADER: path.join(FX, 'fake-grader.js'), FAKE_DOCKER_SCENARIO: path.join(d, 'scenario.json'), FAKE_BASE: 'base' } });
    const summary = JSON.parse(fs.readFileSync(path.join(d, 'out', 'summary.json'), 'utf8'));
    const log = fs.readFileSync(calls, 'utf8'); fs.rmSync(d, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const x = byLabel(summary, 'iso-empty-patch-file');
    assert.equal(x.outcome, 'empty_patch_excluded'); assert.equal(x.grade, undefined); assert.equal(x.expectation_met, true);
    assert.deepEqual(x.steps, [], 'no docker step recorded for the excluded run');
    assert.doesNotMatch(log, /iso-empty-patch-file/, 'the fake docker was never called for the excluded run');
    assert.match(log, /iso-patch-conflict/, 'the conflict control still runs in a container');
    assert.equal(byLabel(summary, 'empty').outcome, 'graded', 'the intentional no-candidate baseline is unaffected');
  });
  test('review 10568: only an exactly-empty string is excluded (harness rule); whitespace-only and the no-candidate baseline are not', async () => {
    const { harnessExcludesPatch } = await import(GRADE);
    assert.equal(harnessExcludesPatch(''), true);
    for (const p of [' ', '\n', ' \n\t', 'diff --git a/x b/x\n', null, undefined]) assert.equal(harnessExcludesPatch(p), false, JSON.stringify(p));
  });
  test('review 10568: per-run log diagnostics are recorded (counts and booleans only) without changing grading', () => {
    const r = run({ jqMissing: { gold: true }, resultsOutside: { gold: true } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const g = byLabel(r.summary, 'gold'); const e = byLabel(r.summary, 'empty');
    assert.equal(g.outcome, 'graded'); assert.equal(g.expectation_met, true, 'diagnostics never change the outcome');
    assert.deepEqual(Object.keys(g.log_diag).sort(), ['command_not_found', 'end_marker', 'jq_available', 'jq_error', 'output_capture', 'section_result_lines', 'start_marker', 'whole_log_result_lines']);
    assert.equal(g.log_diag.jq_available, false); assert.equal(e.log_diag.jq_available, true);
    assert.equal(g.log_diag.start_marker, true); assert.equal(g.log_diag.end_marker, true);
    assert.equal(g.log_diag.section_result_lines, 0); assert.equal(g.log_diag.whole_log_result_lines, 2, 'result lines outside the markers are counted separately');
    assert.equal(e.log_diag.whole_log_result_lines, 0);
    assert.equal(g.log_diag.output_capture, 'stdout_then_stderr');
    assert.equal(g.grade.log_gate, 'ok');
    assert.ok(g.steps.some((s) => /jq availability/.test(s.step)), 'the jq probe is a recorded step');
  });
  test('review 10557: a manifest whose entry count differs from the printed FILES is an infrastructure error', () => {
    const r = run({ manifestFilesOff: { gold: 1 } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'infra_error'); assert.match(byLabel(r.summary, 'gold').infra_step, /count/);
  });
  test('review 10557: a malformed manifest line is an infrastructure error', () => {
    const r = run({ manifestMalformed: { gold: true } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'infra_error'); assert.match(byLabel(r.summary, 'gold').infra_step, /malformed/);
  });
  test('review 10557: a duplicate manifest path is an infrastructure error', () => {
    const r = run({ manifestDuplicate: { gold: true } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'infra_error'); assert.match(byLabel(r.summary, 'gold').infra_step, /duplicate/);
  });
  test('review 10554: missing test-file entries never compare equal (tamper proof fails)', () => {
    const r = run({ manifestMissing: { gold: true, 'iso-test-file-tamper': true } });
    assert.equal(r.status, 1);
    assert.ok(byLabel(r.summary, 'iso-test-file-tamper').expectation_failures.some((x) => /missing/.test(x)), JSON.stringify(byLabel(r.summary, 'iso-test-file-tamper').expectation_failures));
  });
  test('review 10554: QBX_EVAL_EXIT must equal the observed wrapper exit', () => {
    const r = run({ evalExitPrinted: { gold: 1 } });
    assert.equal(r.status, 1); assert.equal(byLabel(r.summary, 'gold').outcome, 'infra_error'); assert.match(byLabel(r.summary, 'gold').infra_step, /exit/);
  });
  test('review 10554: node_modules changing between start and the test boundary is an infrastructure error', () => {
    const r = run({ nodeModulesChanged: { gold: true } });
    assert.equal(r.status, 1); assert.match(byLabel(r.summary, 'gold').infra_step, /node_modules/);
  });
  test('review 10554: every step records its status and a redacted output tail, including rejected patch attempts', () => {
    const r = run({});
    const c = byLabel(r.summary, 'iso-patch-conflict');
    const attempts = c.steps.filter((x) => /^apply attempt/.test(x.step));
    assert.equal(attempts.length, 4); assert.ok(attempts.every((x) => x.status === 1 && typeof x.stderr_tail === 'string'));
    assert.ok(c.steps.some((x) => /reverse check/.test(x.step)));
  });
});

describe('KAN-111 review 10554: execution guards (no live calls)', () => {
  const guard = (args, env = {}) => {
    const d = setup({}); const t = tripwire(d);
    const r = spawnSync(process.execPath, [GRADE, ...args, `--out=${path.join(d, 'out')}`], { encoding: 'utf8', env: { ...process.env, ...t, ...env, GITHUB_ACTIONS: env.GITHUB_ACTIONS || '', KAN111_CI_RUN: env.KAN111_CI_RUN || '' } });
    const live = fs.existsSync(path.join(d, 'LIVE-DOCKER-CALLED')); const wrote = fs.existsSync(path.join(d, 'out'));
    fs.rmSync(d, { recursive: true, force: true }); return { status: r.status, live, wrote, stderr: r.stderr };
  };
  test('real (non-fixture) execution is refused outside the approved CI route', () => {
    const r = guard(['--execute', '--approved-by=NOT-A-REAL-APPROVAL']);
    assert.equal(r.status, 2, r.stderr); assert.equal(r.live, false); assert.equal(r.wrote, false);
    assert.match(r.stderr, /CI/);
  });
  test('approved execution requires reps >= 3 and variant A1', () => {
    const env = { GITHUB_ACTIONS: 'true', KAN111_CI_RUN: '1' };
    for (const a of [['--reps=2'], ['--reps=0'], ['--reps=x'], ['--variant=A0']]) {
      const r = guard(['--execute', '--approved-by=NOT-A-REAL-APPROVAL', ...a], env);
      assert.equal(r.status, 2, `${a}: ${r.stderr}`); assert.equal(r.live, false); assert.equal(r.wrote, false);
    }
  });
});
