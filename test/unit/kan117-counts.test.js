// KAN-117: the recount rule (bench/public/kan117/counts.mjs). Static; runs nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const load = () => import(path.join(ROOT, 'bench/public/kan117/counts.mjs'));
const task = (id, reasons, facts = {}) => ({
  task_id: id, source: facts.source || 'src', classification: { status: 'incompatible', reasons },
  facts: { services: [], qb_deps_plan: { status: 'blocked' }, runner_from_grader: [], runner_from_scripts: { frameworks: [] }, ...facts },
});

test('every committed reason maps to exactly one blocker key', async () => {
  const { summarize } = await load();
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/manifest/candidates.json'), 'utf8'));
  assert.deepStrictEqual(summarize(doc).unmapped_reasons, []);
});

test('an unknown reason is reported as unmapped, never dropped', async () => {
  const { summarize } = await load();
  const s = summarize({ tasks: [task('t1', ['some new reason'])] });
  assert.deepStrictEqual(s.unmapped_reasons, [{ task_id: 't1', reason: 'some new reason' }]);
  assert.strictEqual(s.bounds.A_runner_and_or_deps_only.total, 0);
});

test('bounds: runner/deps-only counts in A; services or no root package.json never count', async () => {
  const { summarize } = await load();
  const R = 'QB refuses: detected runner jest (QB executes node:test only)';
  const D = 'QB sandbox refuses dependencies: setup_missing_lockfile';
  const N = 'QB refuses: no package.json "test" script';
  const S = 'needs services not available in the QB sandbox: redis';
  const s = summarize({ tasks: [
    task('a', [R]), task('b', [R, D]), task('c', [D, N]), task('d', [R, S]), task('e', ['no package.json at the repository root', R]),
  ] });
  assert.strictEqual(s.bounds.A_runner_and_or_deps_only.total, 2);
  assert.strictEqual(s.bounds.B_plus_no_test_script.total, 3);
  assert.deepStrictEqual(s.blocker_sets, { runner: 1, 'deps+runner': 1, 'deps+no_test_script': 1, 'runner+services': 1, 'no_root_package+runner': 1 });
});

test('runner comes from the grading command first, then package.json scripts', async () => {
  const { actualRunner } = await load();
  assert.deepStrictEqual(actualRunner(task('x', [], { runner_from_grader: ['mocha'], runner_from_scripts: { frameworks: ['jest'] } })), { runner: 'mocha', from: 'grading_command' });
  assert.deepStrictEqual(actualRunner(task('x', [], { runner_from_scripts: { frameworks: ['jest'] } })), { runner: 'jest', from: 'package_scripts' });
  assert.deepStrictEqual(actualRunner(task('x', [])), { runner: 'unknown', from: 'none' });
});

test('committed counts.json equals a fresh recount of the committed candidates.json', async () => {
  const { summarize } = await load();
  const buf = fs.readFileSync(path.join(ROOT, 'bench/public/manifest/candidates.json'));
  const fresh = summarize(JSON.parse(buf));
  const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/counts.json'), 'utf8'));
  assert.strictEqual(saved.input.sha256, require('node:crypto').createHash('sha256').update(buf).digest('hex'));
  delete saved.input.file; delete saved.input.sha256;
  assert.deepStrictEqual(saved, JSON.parse(JSON.stringify(fresh)));
  assert.strictEqual(fresh.totals.statically_eligible_existing_rules, 0);
  assert.strictEqual(fresh.bounds.A_runner_and_or_deps_only.total, 1634);
});
