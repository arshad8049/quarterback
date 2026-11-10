/**
 * KAN-111 review 10559: grade results are published only through grade-sanitize.mjs. Synthetic inputs only:
 * a fake vault with made-up test names and a fake summary; no Docker, no network, no real task material.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const S = path.join(__dirname, '..', '..', 'bench', 'public', 'grader', 'immutable-offline-v1', 'grade-sanitize.mjs');
const NAME = 'fake suite › fake hidden test title';
function setup(runOverrides = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan111-san-'));
  fs.mkdirSync(path.join(d, 'store', 'vault'), { recursive: true });
  fs.writeFileSync(path.join(d, 'store', 'vault', 'swe-bench-multilingual.jsonl'), JSON.stringify({ task_id: 't', FAIL_TO_PASS: JSON.stringify([NAME]), PASS_TO_PASS: ['another fake title here'] }) + '\n');
  const run = {
    task: '2006', instance_id: 'x__y-1', label: 'gold', rep: 1, outcome: 'graded', expectation_met: true, expectation_failures: [],
    infra_detail: `stderr mentions ${NAME}`, patch_apply: { ok: true, via: 'git apply --verbose', stdout: 'Checking patch src/a.js' },
    steps: [{ step: 'apply attempt 1', status: 0, signal: null, stdout_tail: `ok ${NAME}`, stderr_tail: 'diff --git a/x b/x' }],
    tested_tree: { sha256: 'a'.repeat(64), files: 3, marker_count: 0, node_modules: 'b'.repeat(64), extra: 'dropped' },
    grade: { mode: 'gold', accepted: true, official: 'RESOLVED_FULL', reasons: ['FAIL_TO_PASS[0]: expected passed, got failed', `free text ${NAME}`] },
    wrapper_env: ['CI=<unset>', 'node=v20.0.0'], ...runOverrides,
  };
  fs.mkdirSync(path.join(d, 'raw'));
  fs.writeFileSync(path.join(d, 'raw', 'summary.json'), JSON.stringify({ adaptation: 'immutable-offline-v1', variant: 'A1', gates_passed: true, plan: ['docker pull x'], runs: [run] }));
  return d;
}
const crypto = require('crypto');
const ID = { 'qb-commit': 'c'.repeat(40), 'dataset-revision': '846e647b9f33c0b51b739d005d13d85493c9af09', 'lock-sha256': '3ff9e5ec290027e4925964a8eb537af39f676a588aa81d9da2f429619e7de1ba' };
function installDir(d) {
  const i = path.join(d, 'install'); fs.mkdirSync(i, { recursive: true });
  for (const f of ['swebench-rebuilt-wheel.sha256', 'pip-check.txt', 'pip-freeze.txt', 'installed-harness-files.sha256', 'harness-smoke.txt', 'install-provenance.json']) fs.writeFileSync(path.join(i, f), `fixture ${f}\n`);
  return i;
}
const idArgs = (d, over = {}) => Object.entries({ ...ID, 'install-dir': installDir(d), ...over }).filter(([, v]) => v !== null).map(([k, v]) => `--${k}=${v}`);
const go = (d, over) => spawnSync(process.execPath, [S, path.join(d, 'raw'), path.join(d, 'pub'), path.join(d, 'store'), ...idArgs(d, over)], { encoding: 'utf8' });

describe('KAN-111 grade-sanitize.mjs', () => {
  test('publishes only results.json and sanitize-report.txt, with tails, details and unknown fields dropped', () => {
    const d = setup(); const r = go(d);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(d, 'pub')).sort(), ['results.json', 'sanitize-report.txt']);
    const doc = fs.readFileSync(path.join(d, 'pub', 'results.json'), 'utf8'); const j = JSON.parse(doc);
    assert.equal(j.sanitized, true); assert.equal(j.runs[0].infra_detail, undefined);
    assert.deepEqual(Object.keys(j.runs[0].steps[0]).sort(), ['signal', 'status', 'step']);
    assert.equal(j.runs[0].tested_tree.extra, undefined); assert.equal(j.runs[0].patch_apply.stdout, undefined);
    assert.deepEqual(j.runs[0].grade.reasons, ['FAIL_TO_PASS[0]: expected passed, got failed', '<redacted reason>']);
    assert.doesNotMatch(doc, /fake hidden test title|diff --git/);
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('a required test name in an allowlisted field is refused: exit 1, nothing published, the name is not printed', () => {
    const d = setup({ expectation_failures: [`tested ${NAME} differs`] }); const r = go(d);
    assert.equal(r.status, 1); assert.equal(fs.existsSync(path.join(d, 'pub')), false);
    assert.match(r.stderr, /required test name #0/); assert.doesNotMatch(r.stderr + r.stdout, /fake hidden test title/);
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('patch text or a secret-like string in an allowlisted field is refused', () => {
    for (const bad of ['diff --git a/src/x b/src/x', 'token ghp_abcdefghijklmnop']) {
      const d = setup({ infra_step: bad }); const r = go(d);
      assert.equal(r.status, 1, bad); assert.equal(fs.existsSync(path.join(d, 'pub')), false);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  test('an unreadable summary or an empty vault is refused (cannot check, so nothing is published)', () => {
    const d = setup(); fs.rmSync(path.join(d, 'raw', 'summary.json')); assert.equal(go(d).status, 1); fs.rmSync(d, { recursive: true, force: true });
    const e = setup(); fs.writeFileSync(path.join(e, 'store', 'vault', 'swe-bench-multilingual.jsonl'), '');
    assert.equal(go(e).status, 1); assert.equal(fs.existsSync(path.join(e, 'pub')), false); fs.rmSync(e, { recursive: true, force: true });
  });
});

// Review 10561 (correction 2): run the REAL runner (fake docker and grader) and sanitize its actual output
const GRADE = path.join(__dirname, '..', '..', 'bench', 'public', 'grader', 'immutable-offline-v1', 'grade.mjs');
const FX = path.join(__dirname, '..', 'fixtures', 'kan111');
const EVAL = "set -uxo pipefail\ncd /testbed\nnpm run build\n: '>>>>> Start Test Output'\n(npx jest __tests__/Range.ts --verbose) | cat\n: '>>>>> End Test Output'\n";
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
function runnerOutput() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan111-san-run-'));
  const store = path.join(d, 'store'); fs.mkdirSync(path.join(store, 'controller'), { recursive: true }); fs.mkdirSync(path.join(store, 'vault'), { recursive: true });
  const row = { task_id: 'qbt_fixture', instance_id: 'immutable-js__immutable-js-2006' };
  fs.writeFileSync(path.join(store, 'controller', 'swe-bench-multilingual.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), JSON.stringify({ ...row, eval_script: EVAL, patch: 'diff --git a/src/a.js b/src/a.js\n', FAIL_TO_PASS: [NAME], PASS_TO_PASS: ['another fake title here'] }) + '\n');
  fs.writeFileSync(path.join(d, 'fixture.json'), JSON.stringify({ store, tasks: { 2006: { task_id: 'qbt_fixture', instance_id: 'immutable-js__immutable-js-2006', base: 'base', image: 'fixture/image@sha256:' + '0'.repeat(64),
    eval_sha256: sha(EVAL), test_files: ['__tests__/Range.ts'], a1_build: 'npm run build:clean && npm run build:dist' } } }));
  fs.writeFileSync(path.join(d, 'scenario.json'), '{}');
  const r = spawnSync(process.execPath, [GRADE, '--execute', '--approved-by=FIXTURE', '--reps=1', '--fixture-timeout=1', `--out=${path.join(d, 'raw')}`], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, QB_KAN111_FIXTURE: path.join(d, 'fixture.json'), QB_KAN111_DOCKER: path.join(FX, 'fake-docker.js'), SWEBENCH_PYTHON: process.execPath,
      QB_KAN111_GRADER: path.join(FX, 'fake-grader.js'), FAKE_DOCKER_SCENARIO: path.join(d, 'scenario.json'), FAKE_BASE: 'base' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return d;
}

describe('KAN-111 grade-sanitize.mjs on runner-shaped records (review 10561)', () => {
  test('the runner\'s real fingerprint fields survive as 64-hex values; patch, eval and log text do not', () => {
    const d = runnerOutput(); const r = go(d);
    assert.equal(r.status, 0, r.stderr);
    const doc = fs.readFileSync(path.join(d, 'pub', 'results.json'), 'utf8'); const j = JSON.parse(doc);
    const gold = j.runs.find((x) => x.label === 'gold'); const empty = j.runs.find((x) => x.label === 'empty');
    for (const k of ['eval_sha256', 'official_eval_sha256', 'patch_sha256', 'diff_before_sha256']) assert.match(String(gold[k]), /^[0-9a-f]{64}$/, `gold ${k}`);
    for (const k of ['eval_sha256', 'official_eval_sha256']) assert.match(String(empty[k]), /^[0-9a-f]{64}$/, `empty ${k}`);
    assert.match(String(gold.tested_tree.sha256), /^[0-9a-f]{64}$/);
    assert.doesNotMatch(doc, /diff --git|npx jest|Start Test Output|fake hidden test title/);
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('a fingerprint field that is not a 64-hex SHA is refused (nothing published)', () => {
    const d = setup({ eval_sha256: 'not-a-sha' }); const r = go(d);
    assert.equal(r.status, 1); assert.equal(fs.existsSync(path.join(d, 'pub')), false); assert.match(r.stderr, /eval_sha256/);
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('the experiment identity is recorded: QB commit, dataset revision, reviewed lock hash and install provenance hashes', () => {
    const d = setup(); const r = go(d); assert.equal(r.status, 0, r.stderr);
    const e = JSON.parse(fs.readFileSync(path.join(d, 'pub', 'results.json'), 'utf8')).experiment;
    assert.equal(e.qb_commit, ID['qb-commit']); assert.equal(e.dataset_revision, ID['dataset-revision']); assert.equal(e.lock_sha256, ID['lock-sha256']);
    assert.deepEqual(Object.keys(e.install_record_sha256).sort(), ['harness-smoke.txt', 'install-provenance.json', 'installed-harness-files.sha256', 'pip-check.txt', 'pip-freeze.txt', 'swebench-rebuilt-wheel.sha256']);
    assert.equal(e.install_record_sha256['pip-check.txt'], sha('fixture pip-check.txt\n'));
    fs.rmSync(d, { recursive: true, force: true });
  });
  for (const [k, v] of [['qb-commit', 'abc'], ['dataset-revision', null], ['lock-sha256', 'x'.repeat(64)]]) {
    test(`a missing or malformed --${k} is refused`, () => { const d = setup(); assert.equal(go(d, { [k]: v }).status, 1); assert.equal(fs.existsSync(path.join(d, 'pub')), false); fs.rmSync(d, { recursive: true, force: true }); });
  }
  test('an install record with a missing or unexpected file is refused', () => {
    const d = setup(); const i = installDir(d); fs.writeFileSync(path.join(i, 'extra.txt'), 'x'); assert.equal(go(d, { 'install-dir': i }).status, 1);
    fs.rmSync(path.join(i, 'extra.txt')); fs.rmSync(path.join(i, 'pip-check.txt')); assert.equal(go(d, { 'install-dir': i }).status, 1);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
