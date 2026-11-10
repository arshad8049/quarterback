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
const go = (d) => spawnSync(process.execPath, [S, path.join(d, 'raw'), path.join(d, 'pub'), path.join(d, 'store')], { encoding: 'utf8' });

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
