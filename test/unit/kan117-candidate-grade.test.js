/**
 * KAN-117 review 10607: grade.mjs candidate mode, end to end with the KAN-111 fake docker and fake grader
 * (test/fixtures/kan111). Nothing here runs Docker, the SWE-bench harness or task code.
 */
const { test } = require('node:test');
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

function run(scenario, { patch = 'diff --git a/src/a.js b/src/a.js\n', label = 'x', extra = [], env = {}, fixture = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan117g-'));
  const store = path.join(d, 'store'); fs.mkdirSync(path.join(store, 'controller'), { recursive: true }); fs.mkdirSync(path.join(store, 'vault'), { recursive: true });
  const row = { task_id: 'qbt_fixture', instance_id: 'immutable-js__immutable-js-2006' };
  fs.writeFileSync(path.join(store, 'controller', 'swe-bench-multilingual.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), JSON.stringify({ ...row, eval_script: EVAL, patch: 'gold', FAIL_TO_PASS: ['f'], PASS_TO_PASS: ['p'] }) + '\n');
  fs.writeFileSync(path.join(d, 'fixture.json'), JSON.stringify({ store, tasks: { 2006: { task_id: 'qbt_fixture', instance_id: 'immutable-js__immutable-js-2006', base: 'base',
    image: 'fixture/image@sha256:' + '0'.repeat(64), eval_sha256: sha(EVAL), test_files: ['__tests__/Range.ts'], a1_build: 'npm run build:clean' } } }));
  fs.writeFileSync(path.join(d, 'scenario.json'), JSON.stringify(scenario));
  fs.writeFileSync(path.join(d, 'cand.diff'), patch);
  const bin = path.join(d, 'tripwire-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(d, 'LIVE'))}\nexit 1\n`); fs.chmodSync(path.join(bin, 'docker'), 0o755);
  const base = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, QB_KAN111_DOCKER: path.join(FX, 'fake-docker.js'), SWEBENCH_PYTHON: process.execPath,
    QB_KAN111_GRADER: path.join(FX, 'fake-grader.js'), FAKE_DOCKER_SCENARIO: path.join(d, 'scenario.json'), FAKE_BASE: 'base', GITHUB_ACTIONS: '', KAN117_CI_RUN: '' };
  if (fixture) base.QB_KAN111_FIXTURE = path.join(d, 'fixture.json');
  const r = spawnSync(process.execPath, [GRADE, '--execute', `--approved-by=${fixture ? 'FIXTURE' : '10607'}`, `--candidate=${path.join(d, 'cand.diff')}`, '--task=2006', `--label=${label}`, `--out=${path.join(d, 'out')}`, ...extra],
    { encoding: 'utf8', timeout: 60_000, env: { ...base, ...env } });
  const f = path.join(d, 'out', `candidate-${label}.json`);
  const res = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const live = fs.existsSync(path.join(d, 'LIVE'));
  fs.rmSync(d, { recursive: true, force: true });
  assert.equal(live, false, 'a real docker was invoked');
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, res };
}

test('a captured candidate is graded with its hash and apply outcome, and NO expected outcome', () => {
  const patch = 'diff --git a/src/a.js b/src/a.js\n';
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.res.expected_outcome, null);
  assert.equal(r.res.candidate.file_sha256, sha(patch));
  assert.equal(r.res.run.patch_sha256, sha(patch));
  assert.equal(r.res.run.patch_apply.ok, true);
  assert.deepEqual([r.res.run.outcome, r.res.run.grade.mode, r.res.run.grade.official, r.res.run.grade.evidence_valid], ['graded', 'candidate', 'RESOLVED_NO', true]);
  assert.equal(r.res.run.invalid_kind, null);
  assert.equal('accepted' in r.res.run.grade, false, 'no acceptance decision in candidate mode');
});

test('an empty candidate is recorded as excluded by the harness and graded as the no-patch replay', () => {
  const r = run({}, { patch: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.res.candidate.empty, true);
  assert.match(r.res.run.harness_submission, /excluded/);
  assert.match(r.res.run.patch_apply.skipped, /empty candidate/);
  assert.equal(r.res.run.outcome, 'graded');
});

test('a patch that does not apply is patch_apply_failed and never graded (a determinate outcome, exit 0)', () => {
  const r = run({ apply: { 'candidate-x': 1 } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.res.run.outcome, 'patch_apply_failed');
  assert.equal(r.res.run.grade, undefined);
});

test('wrong base and invalid evidence are invalid/harness outcomes (exit 3), not model failures', () => {
  const wb = run({ baseCheck: { 'candidate-x': 1 } });
  assert.equal(wb.status, 3); assert.equal(wb.res.run.invalid_kind, 'wrong_base');
  const ie = run({ grade: { 'candidate-x': { valid: false } } });
  assert.equal(ie.status, 3); assert.equal(ie.res.run.invalid_kind, 'invalid_evidence');
});

test('authorization: outside CI, without KAN117_CI_RUN, or with a non-matching approval, nothing runs (exit 2)', () => {
  assert.equal(run({}, { fixture: false }).status, 2);
  assert.equal(run({}, { fixture: false, env: { GITHUB_ACTIONS: 'true' } }).status, 2, 'CI=true alone is not authorization');
  const wrong = spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=1', '--candidate=/dev/null', '--task=2006', '--label=x'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', KAN117_CI_RUN: '1', QB_KAN111_FIXTURE: '' } });
  assert.equal(wrong.status, 2); assert.match(wrong.stderr, /approvals\.json/);
  assert.equal(run({}, { label: 'BAD LABEL' }).status, 2);
});
