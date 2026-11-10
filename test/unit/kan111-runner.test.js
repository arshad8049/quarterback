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
function run(scenario, extra = []) {
  const d = setup(scenario);
  const r = spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=FIXTURE', '--reps=1', '--fixture-timeout=1', `--out=${path.join(d, 'out')}`, ...extra], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, QB_KAN111_FIXTURE: path.join(d, 'fixture.json'), QB_KAN111_DOCKER: path.join(FX, 'fake-docker.js'), SWEBENCH_PYTHON: process.execPath,
      QB_KAN111_GRADER: path.join(FX, 'fake-grader.js'), FAKE_DOCKER_SCENARIO: path.join(d, 'scenario.json'), FAKE_BASE: 'base' } });
  const summaryPath = path.join(d, 'out', 'summary.json');
  const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
  fs.rmSync(d, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary };
}
const byLabel = (s, l) => s.runs.find((x) => x.label === l);

describe('KAN-111 runner gates (fake docker and grader; no real execution)', () => {
  test('all gates met: exit 0, fixture mode recorded, every expectation satisfied', () => {
    const r = run({});
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
  test('patch conflict or zero-byte patch that unexpectedly applies fails the isolation gate', () => {
    const r = run({ apply: { default: 0 } });
    assert.equal(r.status, 1);
    assert.equal(byLabel(r.summary, 'iso-patch-conflict').expectation_met, false);
    assert.equal(byLabel(r.summary, 'iso-empty-patch-file').expectation_met, false);
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
});
