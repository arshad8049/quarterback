/**
 * KAN-106, senior decision 10690 (on cc836703): two issues before another model smoke.
 *
 * (1) The "corrected" b2416ebc fixture was structurally finalized but not a faithful executable
 *     checklist: its CHK-1…CHK-5 call the exported class `Serializer` with args [] (never asNumber),
 *     the identical call expects 0 and 12.5, and numeric preservation is "enforced" by
 *     allowed_changes. It is relabelled structural-only (b2416ebc-structural-only.json) and is now
 *     rejected by narrow check-fidelity rules. A human-reviewed fixture (pinned-api-honest.json) is
 *     built on the pinned repository's REAL API (`module.exports = class Serializer`; asNumber is an
 *     instance method returning strings), proved here with the real check runner against the
 *     pinned source, fixed and base. Capability gap, reported not invented: no registry adapter can
 *     assert that a METHOD call throws, so AC-1/AC-2 carry no check and stay unresolved.
 * (2) adds_tests overclaimed: the textual witness is now ADVISORY. It never yields met=true on its
 *     own; demonstrated failures stay met=false; everything else is unresolved / human review.
 * No model, no Claude, no Docker.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const REQUEST = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const HONEST = read('pinned-api-honest.json');
const STRUCTURAL = read('b2416ebc-structural-only.json');
const INITIAL = read('b2416ebc-initial.json');
const REPAIRED = read('b2416ebc-repair.json');
const FAITHFUL = read('faithful-draft.json');
const SMOKE = JSON.parse(read('b2416ebc-errors.json'));
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
const TREE = 'e'.repeat(40);

const compiler = () => require('../../intent/compiler');
const state = () => require('../../intent/contract-state');
const variant = (text, edit) => { const d = JSON.parse(text); edit(d); return JSON.stringify(d); };
function contractOf(text, request = REQUEST) {
  const { resolveInRequest } = require('../../intent/passages');
  const raw = JSON.parse(text);
  raw.requirements = raw.requirements.map((r) => (r.passage_ids ? { ...r, quote: resolveInRequest(request, r.passage_ids).text } : r));
  return compiler().contractFromObject(raw, request);
}
const errorsOf = (text, edit = null) => { const s = state().contractState(contractOf(edit ? variant(text, edit) : text)); return s.state === 'finalized' ? [] : s.errors; };

/** Run checks with the REAL runner against a repository holding the pinned serializer (fixed or base). */
function runChecks(checks, { base = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-10690-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pinned","type":"commonjs"}');
    fs.writeFileSync(path.join(dir, 'lib', 'serializer.js'), base ? PINNED.replace(GUARD, '') : PINNED);
    const out = path.join(dir, 'results.json');
    const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: dir, checks }), encoding: 'utf8',
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(out, 'utf8');
    return { text, byId: Object.fromEntries(JSON.parse(text).results.map((x) => [x.id, x])) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('10690 (1): fixtures are labelled for what they are', () => {
  test('the old "corrected" fixture is relabelled structural-only; the index labels every KAN-106 fixture', () => {
    assert.equal(fs.existsSync(path.join(FIX, 'b2416ebc-corrected.json')), false);
    const idx = read('FIXTURES.md');
    assert.match(idx, /`b2416ebc-structural-only\.json` \| \*\*structural-only\*\*/);
    assert.match(idx, /`pinned-api-honest\.json` \| \*\*human-reviewed, faithful to the pinned repository\*\*/);
    assert.match(idx, /`faithful-draft\.json` \| \*\*synthetic API\*\*/);
    assert.match(idx, /`b2416ebc-initial\.json`, `b2416ebc-repair\.json` \| \*\*observed\*\*/);
  });
  test('the pinned source is the real one: the class is the module export, asNumber returns strings, and the guard is the fix', () => {
    assert.match(PINNED, /^module\.exports = class Serializer \{$/m);
    assert.ok(PINNED.includes(GUARD), 'the base is derived by removing exactly the blank-string guard');
  });
});

describe('10690 (1): the real check runner against the pinned source', () => {
  const honest = JSON.parse(HONEST).checks;
  test('the honest checks (call_sequence on new Serializer(), asNumber, string results) pass on the fixed AND the base source: they preserve', () => {
    for (const base of [false, true]) {
      const { byId } = runChecks(honest, { base });
      for (const id of ['CHK-3', 'CHK-4', 'CHK-5']) assert.equal(byId[id].status, 'pass', `${base ? 'base' : 'fixed'} ${id}: ${byId[id].detail}`);
    }
  });
  test('the structural-only checks are wrong on the real module: there is no export named Serializer, and asNumber is never called', () => {
    const s = JSON.parse(STRUCTURAL).checks;
    const { byId } = runChecks(s);
    for (const id of ['CHK-1', 'CHK-2', 'CHK-3', 'CHK-4', 'CHK-5']) {
      assert.equal(byId[id].status, 'fail', id);
      assert.match(byId[id].detail, /lib\/serializer\.js export Serializer is not a function/, id);
    }
    // …and pointing call_throws at the class itself (the default export) "passes" for the wrong reason:
    // the class throws because it is called without new, not because asNumber rejects anything.
    const vacuous = [{ ...s[0], params: { module: 'lib/serializer.js', export: 'default', args: [] } }];
    const v = runChecks(vacuous).byId['CHK-1'];
    assert.equal(v.status, 'pass');
    assert.match(v.detail, /Class constructor Serializer cannot be invoked without 'new'/);
  });
  test('capability gap: a method call that SHOULD throw cannot be expressed; call_sequence reports a throw as a failure', () => {
    const gap = [{ id: 'GAP-1', ac_id: 'AC-1', adapter: 'call_sequence', params: { module: 'lib/serializer.js', export: 'default',
      instances: { s: { construct: 'new', args: [] } }, steps: [{ on: 's', method: 'asNumber', args: [''], expect: null }] } }];
    const r = runChecks(gap).byId['GAP-1'];
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /step 0: s\.asNumber\(…\) threw: The value "" cannot be converted to a number\./);
    const { ADAPTERS } = require('../../verify/checks/registry');
    assert.deepEqual(ADAPTERS, ['module_exports', 'call_returns', 'call_sequence', 'call_throws'], 'no adapter was invented');
  });
});

describe('10690 (1): narrow check-fidelity rules reject the demonstrated wrong mapping', () => {
  test('the honest fixture passes full validation', () => {
    assert.deepEqual(errorsOf(HONEST), []);
  });
  test('the structural-only fixture is rejected: checks that never call the named method, contradictory identical calls, behaviour "enforced" by allowed_changes', () => {
    const e = errorsOf(STRUCTURAL).join('\n');
    for (const id of ['CHK-1', 'CHK-2', 'CHK-3', 'CHK-4', 'CHK-5']) {
      assert.match(e, new RegExp(`${id} \\(AC-\\d\\) never calls asNumber, which AC-\\d names \\(Serializer\\.asNumber\\(\\)\\): it calls the export Serializer directly with no arguments`));
    }
    assert.match(e, /CHK-3 and CHK-5 make the identical call Serializer\(\) but expect different results \(0 vs 12\.5\): at most one can be right/);
    assert.match(e, /constraint 0 \("The behavior for numeric 0 must not change\."\) is about behaviour, but allowed_changes only shows where edits are permitted, not that the behaviour is kept: enforce it with a check that exercises it, or mark it advisory/);
  });
  test('the rules are narrow: a check on the named function itself, or a call_sequence step calling the method, is accepted', () => {
    assert.deepEqual(errorsOf(FAITHFUL), [], 'export asNumber (synthetic API) still validates structurally');
    const advisory = (d) => { d.constraint_policy[2] = { constraint: 2, advisory: true }; };
    assert.deepEqual(errorsOf(HONEST, advisory), [], 'a behaviour constraint marked advisory is allowed');
  });
  test('the observed b2416ebc drafts stay rejected: their recorded errors plus the fidelity errors', () => {
    const [i, r] = [errorsOf(INITIAL), errorsOf(REPAIRED)];
    for (const e of SMOKE.errors[0]) assert.ok(i.includes(e), e);
    for (const e of SMOKE.errors[1]) assert.ok(r.includes(e), e);
    assert.ok(r.some((e) => /CHK-3 \(AC-3\) never calls asNumber/.test(e)));
    assert.ok(i.some((e) => /is about behaviour, but allowed_changes only shows where edits are permitted/.test(e)));
  });
});

describe('10690 (1): every criterion\'s actual evidence path (honest fixture, real runner results, verify())', () => {
  test('AC-1/AC-2 no check → unresolved; AC-3…AC-5 decided by their executed checks; AC-6 adds_tests advisory → human review', async () => {
    const contract = state().approve(contractOf(HONEST), { via: 'test' });
    const { checkSetHash } = require('../../verify/checks/registry');
    const { text } = runChecks(contract.checks);
    const L = (o) => JSON.stringify(o) + '\n';
    const tests = [['empty string throws', true], ['whitespace throws', true], ['zero stays', true]];
    const report = L({ type: 'qb:start', format: 'qb-node-test-events/1' })
      + tests.map(([name]) => L({ type: 'test:pass', name, nesting: 0, path: [], file: '/verify/test/asNumber.test.js', kind: 'test', skip: false, todo: false, failureType: null })).join('')
      + L({ type: 'test:summary', file: null, counts: { tests: 3, passed: 3, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, success: true }) + L({ type: 'qb:end' });
    const diff = 'diff --git a/lib/serializer.js b/lib/serializer.js\n--- a/lib/serializer.js\n+++ b/lib/serializer.js\n@@ -1 +1,2 @@\n+    if (typeof i === \'string\' && i.trim() === \'\') throw new Error(\'x\')\n'
      + 'diff --git a/test/asNumber.test.js b/test/asNumber.test.js\n--- a/test/asNumber.test.js\n+++ b/test/asNumber.test.js\n@@ -1 +1,3 @@\n'
      + "+test('empty string throws', () => { assert.throws(() => new Serializer().asNumber('')) })\n+test('whitespace throws', () => { assert.throws(() => new Serializer().asNumber('  ')) })\n";
    const execution = { id: 'e', status: 'completed', diff, candidate_tree: TREE,
      changes: [{ file: 'lib/serializer.js', status: 'M' }, { file: 'test/asNumber.test.js', status: 'M' }],
      sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report, tree: TREE },
        checks: { tree: TREE, check_set_hash: checkSetHash(contract.checks), results_text: text } } };
    const v = await require('../../verify/verifier').verify(contract, null, execution, { noLlm: true });
    const by = Object.fromEntries(v.criteria_results.map((c) => [c.id, c]));
    assert.deepEqual([by['AC-1'].met, by['AC-1'].method], [null, 'no-check']);
    assert.deepEqual([by['AC-2'].met, by['AC-2'].method], [null, 'no-check']);
    for (const id of ['AC-3', 'AC-4', 'AC-5']) assert.deepEqual([by[id].met, by[id].method, by[id].check_status], [true, 'check', 'passed'], `${id}: ${by[id].evidence}`);
    assert.equal(by['AC-6'].met, null);
    assert.equal(by['AC-6'].human_review, true, by['AC-6'].evidence);
    assert.equal(by['AC-6'].witness?.advisory, true, JSON.stringify(by['AC-6']));
    assert.notEqual(v.verdict, 'pass', 'two unresolved behaviour criteria and an advisory witness cannot pass');
  });
});

describe('10690 (2): the adds_tests witness is advisory; demonstrated failures stay failures', () => {
  const { decideAddedTests } = require('../../verify/added-tests');
  const AC = { id: 'AC-6', criterion: 'adds tests', adds_tests: { files: ['test/asNumber.test.js'] } };
  const hunk = (lines) => `diff --git a/test/asNumber.test.js b/test/asNumber.test.js\n--- a/test/asNumber.test.js\n+++ b/test/asNumber.test.js\n@@ -1,1 +1,${lines.length} @@\n${lines.join('\n')}\n`;
  const exec = (lines) => ({ diff: hunk(lines), changes: [{ file: 'test/asNumber.test.js', status: 'M' }] });
  const run = (passed, failed = [], extra = {}) => ({ outcome: failed.length ? 'failed' : 'passed', byFile: { 'test/asNumber.test.js': { passed: passed.length, failed: failed.length, skipped: 0, passed_names: passed, failed_names: failed, ...extra } } });
  const decide = (lines, cls, ids = ['asNumber']) => decideAddedTests(AC, cls, exec(lines), ids);

  test('new relevant cases that ran and passed: NOT met=true from the heuristic alone; advisory witness, human review', () => {
    const r = decide(["+test('empty string throws', () => { assert.throws(() => s.asNumber('')) })"], run(['old', 'empty string throws']));
    assert.equal(r.met, null);
    assert.equal(r.human_review, true);
    assert.equal(r.witness.advisory, true);
    assert.match(r.evidence, /textual heuristic only \(advisory\): human review required/);
  });
  test('a comment "// asNumber(" beside a new unrelated passing test does not count as calling asNumber', () => {
    const r = decide(["+// asNumber('') should throw", "+test('formats dates', () => { assert.equal(formatDate(0), '1970') })"], run(['old', 'formats dates']));
    assert.deepEqual(r.witness.files['test/asNumber.test.js'].mentions, []);
    assert.equal(r.met, null);
    assert.match(r.evidence, /do not call any function the checks exercise/);
  });
  test('skip / todo declarations are not added cases', () => {
    const r = decide(["+test.skip('empty string throws', () => { s.asNumber('') })", "+it.todo('whitespace throws')"], run(['old']));
    const w = r.witness.files['test/asNumber.test.js'];
    assert.deepEqual(w.added, []);
    assert.deepEqual(w.skipped, ['empty string throws', 'whitespace throws']);
    assert.notEqual(r.met, true);
  });
  test('a duplicate title that also names an existing passing case is flagged; never met', () => {
    const lines = [" test('returns numbers', () => { assert.equal(s.asNumber('1'), '1') })", "+test('returns numbers', () => { assert.equal(s.asNumber('2'), '2') })"];
    const r = decide(lines, run(['returns numbers', 'returns numbers']));
    assert.deepEqual(r.witness.files['test/asNumber.test.js'].duplicate_titles, ['returns numbers']);
    assert.equal(r.met, null);
    assert.match(r.evidence, /title also names an existing case \(returns numbers\)/);
  });
  test('irrelevant identifiers pooled across the contract cannot make it met', () => {
    const r = decide(["+test('integers', () => { assert.equal(s.asInteger(1), '1') })"], run(['old', 'integers']), ['asInteger', 'asNumber']);
    assert.deepEqual(r.witness.files['test/asNumber.test.js'].mentions, ['asInteger']);
    assert.equal(r.witness.identifiers_scope, 'contract (not specific to this criterion)');
    assert.equal(r.met, null);
  });
  test('insufficient evidence vs demonstrated failure', () => {
    // demonstrated: only comments added; only deletions; an added case reported failing; a failing test in the file; file unchanged
    assert.equal(decide(['+// TODO cover blanks'], run(['old'])).met, false);
    assert.equal(decide(["-test('old', () => {})"], run(['x'])).met, false);
    assert.equal(decide(["+test('empty string throws', () => { s.asNumber('') })"], run(['old'], ['empty string throws'])).met, false);
    assert.equal(decideAddedTests(AC, run(['old']), { diff: '', changes: [] }, ['asNumber']).met, false);
    // insufficient: code added in a declaration syntax QB does not recognise; an added title not found in the report
    const odd = decide(['+describe(`blank`, function () { check(s.asNumber) })'], run(['old']));
    assert.equal(odd.met, null);
    assert.match(odd.evidence, /no test case declaration QB recognises.*insufficient evidence, not a demonstrated failure/);
    const missing = decide(["+test('empty string throws', () => { s.asNumber('') })"], run(['old']));
    assert.equal(missing.met, null);
    assert.match(missing.evidence, /not found in the test report \(empty string throws\)/);
  });
});
