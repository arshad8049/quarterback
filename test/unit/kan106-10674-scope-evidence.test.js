/**
 * KAN-106, senior decision 10674 (on 10668/10670): the owner's timed Qwen smoke eba7015e
 * (qwen2.5-coder:14b, dry-run, QB 4ed4be5) ended BLOCKED after 345.8 s:
 *   - the first draft allowed test/asNumber.test.js but protected test/** (KAN-105 caught it);
 *   - the one repair "fixed" that by DROPPING test/asNumber.test.js from allowed_changes, so the
 *     requested node:test cases could no longer be written, and QB did not notice;
 *   - no criterion required adding the tests; AC-6 ("existing tests in test/asNumber.test.js still
 *     pass") and AC-7 ("no other tests regress") were bound to asNumber("-7") / asNumber(" 123 ")
 *     value checks, and AC-7 to the glob test/**;
 *   - the repair was finally rejected only because R-1 ("In lib/serializer.js,") had no criterion.
 *
 * Fixtures (test/fixtures/kan106): eba7015e-initial.json and eba7015e-repair.json are the
 * model-authored fields of both rejected drafts from that run's contract-repair artifact (requirement
 * quotes, which QB copies from passages, removed; the checks QB rejected restored as the model wrote
 * them); eba7015e-errors.json the validator's errors there. faithful-draft.json is the same request
 * as a correct contract would be written. No live model, no Claude, no Docker.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const REQUEST = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const INITIAL = fs.readFileSync(path.join(FIX, 'eba7015e-initial.json'), 'utf8');
const REPAIRED = fs.readFileSync(path.join(FIX, 'eba7015e-repair.json'), 'utf8');
const FAITHFUL = fs.readFileSync(path.join(FIX, 'faithful-draft.json'), 'utf8');
// 10812: a SYNTHETIC first draft with a consistent scope (test/fixtures/kan107/synthetic/README.md), not model output
const SYNTHETIC_FIRST = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kan107', 'synthetic', 'consistent-scope-first-draft.json'), 'utf8');
const SMOKE = JSON.parse(fs.readFileSync(path.join(FIX, 'eba7015e-errors.json'), 'utf8'));

// Loaded per test, so a missing module fails each test on its own (red phase).
const load = {
  session: () => require('../../intent/session'),
  state: () => require('../../intent/contract-state'),
  targets: () => require('../../intent/request-targets'),
  compiler: () => require('../../intent/compiler'),
  preservation: () => require('../../verify/preservation'),
  verifier: () => require('../../verify/verifier'),
  budget: () => require('../../lib/budget'),
};
const variant = (text, edit) => { const d = JSON.parse(text); edit(d); return JSON.stringify(d); };

/** compileIntent through the real compiler with scripted model replies (and an optional fake clock). */
async function compileWith(replies, o = {}) {
  let i = 0;
  const m = mockFetch(async (url) => {
    if (url.endsWith('/api/generate')) { if (o.onWarmup) await o.onWarmup(); return { response: '', load_duration: 4_200_000_000 }; }
    const k = Math.min(i++, replies.length - 1);
    if (o.onCall) await o.onCall(k);
    return { ...ollamaReply(replies[k]), ...(o.loadNs ? { load_duration: o.loadNs[k] } : {}) };
  });
  try {
    let s = null; let error = null;
    try { s = await load.session().compileIntent(o.request || REQUEST, o.session || {}); } catch (e) { error = e; }
    return { s, error, calls: m.calls.length, urls: m.calls.map((c) => c.url), prompts: m.calls.filter((c) => c.url.endsWith('/api/chat')).map((c) => JSON.parse(c.init.body).messages) };
  } finally { m.restore(); }
}
/** A model draft as a normalized contract (the compiler's own path, no model call). */
function contractOf(text, request = REQUEST) {
  const { resolveInRequest } = require('../../intent/passages');
  const raw = JSON.parse(text);
  raw.requirements = raw.requirements.map((r) => (r.passage_ids ? { ...r, quote: resolveInRequest(request, r.passage_ids).text } : r));
  return load.compiler().contractFromObject(raw, request);
}
const errorsOf = (text, edit = null) => { const s = load.state().contractState(contractOf(edit ? variant(text, edit) : text)); return s.state === 'finalized' ? [] : s.errors; };

describe('10674 F-a: the request\'s own targets are derived from the request text, narrowly', () => {
  test('the smoke request: lib/serializer.js is an edit target (location + verb), test/asNumber.test.js an add-tests target', () => {
    const r = load.targets().requestTargets(REQUEST);
    assert.deepEqual(r.targets.map((t) => [t.path, t.action, t.passage_id]), [['lib/serializer.js', 'edit', 'P1'], ['test/asNumber.test.js', 'add_tests', 'P6']]);
    assert.deepEqual(r.ambiguous, []);
  });
  test('references, read-only instructions, negations and plain mentions are NOT targets (and never grant permission)', () => {
    const { requestTargets } = load.targets();
    const cases = [
      ['See src/c.js for the pattern.', 'reference'],
      ['Update src/cart.js to reject negative quantities, following the style of src/order.js.', 'reference', 'src/order.js'],
      ['Read config/app.json and make clamp work.', 'reference'],
      ['Do not change src/b.js.', 'negated'],
      ['Leave README.md unchanged.', 'negated'],
      ['Add tests to test/x.test.js without editing lib/y.js.', 'negated'],
      ['Treat docs/api.md as read-only.', 'negated'],
      ['Fix the bug in src/a.js.', 'mentioned'],
    ];
    for (const [req, why, p] of cases) {
      const r = requestTargets(req);
      const path = p || r.ignored[0]?.path;
      assert.ok(!r.targets.some((t) => t.path === path), `${req}: ${path} must not be a target`);
      assert.equal(r.ignored.find((x) => x.path === path)?.why, why, req);
    }
    assert.deepEqual(requestTargets('Update src/cart.js to reject negative quantities, following the style of src/order.js.').targets.map((t) => t.path), ['src/cart.js']);
    assert.deepEqual(requestTargets('Leave README.md unchanged. Create src/new.js.').targets.map((t) => [t.path, t.action]), [['src/new.js', 'add']]);
  });
  test('an unclear instruction ("In lib/a.js, do not …") is a genuine clarifying question, asked before any model call; permission is never invented', async () => {
    const req = 'In lib/a.js, do not change the exports.';
    assert.equal(load.targets().requestTargets(req).ambiguous[0].path, 'lib/a.js');
    const { s, calls } = await compileWith([FAITHFUL], { request: req });
    assert.equal(calls, 0, 'no model call for an open question');
    assert.equal(s.state, 'needs_clarification');
    assert.equal(s.unresolved[0].id, 'scope.target');
    assert.match(s.unresolved[0].question, /May the task change lib\/a\.js\?/);
    // Answered: the model is called, with the answer bound to the question.
    const answered = await compileWith([FAITHFUL], { request: req, session: { answers: ['Yes, edit lib/a.js but keep its exports'] } });
    assert.ok(answered.calls >= 1);
    assert.match(answered.prompts[0].map((m) => m.content).join('\n'), /Q\(|Q: May the task change lib\/a\.js\?[\s\S]*A: Yes, edit lib\/a\.js/);
  });
});

describe('10674: the eba7015e drafts, reproduced offline through compile()', () => {
  test('the exact smoke drafts are rejected; the repair that DROPPED the requested test file is now caught (it was not)', async () => {
    const { s, calls, prompts } = await compileWith([INITIAL, REPAIRED]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    const first = s.repair.rejected[0].errors.join('\n');
    // Protective conflicts remain rejected (KAN-105), with the request-target error beside it.
    assert.ok(first.includes(SMOKE.errors[0][0]), 'the smoke\'s own KAN-105 error is still reported');
    assert.match(first, /the request asks to change test\/asNumber\.test\.js \(P6 "Add node:test cases in test\/asNumber\.test\.js\."\), but scope\.protected_paths "test\/\*\*" protects it/);
    // The repair dropped the file from allowed_changes and kept test/** protected: rejected for the requested work, not just for R-1.
    const last = s.errors.join('\n');
    assert.match(last, /the request asks to change test\/asNumber\.test\.js .* protects it: keep test\/asNumber\.test\.js in allowed_changes and narrow the protection \(a scope conflict is never resolved by dropping requested work\)/);
    // The repair prompt explains the conflict and keeps the test-writing requirement.
    const sent = prompts[1].map((m) => m.content).join('\n');
    // 10812: the repair may not be told to remove a protection a constraint relies on (KAN-105 refuses that)
    assert.match(sent, /keep that file in scope\.allowed_changes\. Remove or narrow a protected_paths glob that covers it only when no constraint_policy entry is enforced by that glob; otherwise leave it as it is \(QB stops and asks the user\)\. Never fix a scope conflict by dropping requested work/);
    assert.match(sent, /Keep the criterion that requires adding the requested tests, with "adds_tests"/);
    assert.match(sent, /Do not mark that requirement "context"/);
  });
  test('dropping the requested test path is rejected even when nothing protects it', () => {
    const errors = errorsOf(FAITHFUL, (d) => { d.scope.allowed_changes = ['lib/serializer.js']; d.acceptance_criteria[5].adds_tests = undefined; delete d.acceptance_criteria[5].adds_tests; });
    assert.match(errors.join('\n'), /the request asks to change test\/asNumber\.test\.js \(P6 .*\), but scope\.allowed_changes does not include it: requested work cannot be dropped/);
  });
  test('dropping the source file, or protecting it, is rejected the same way', () => {
    assert.match(errorsOf(FAITHFUL, (d) => { d.scope.allowed_changes = ['test/asNumber.test.js']; }).join('\n'), /the request asks to change lib\/serializer\.js \(P1 "In lib\/serializer\.js,"\), but scope\.allowed_changes does not include it/);
    const prot = errorsOf(FAITHFUL, (d) => { d.scope.protected_paths = ['lib/**']; d.constraint_policy[1].enforced_by[0].ref = 'lib/**'; }).join('\n');
    assert.match(prot, /entirely covered by scope\.protected_paths "lib\/\*\*"/, 'KAN-105 still rejects the protective conflict');
    assert.match(prot, /the request asks to change lib\/serializer\.js .* protects it/);
  });
  test('glob semantics are the policy\'s own: test/*.test.js allows the target; test/fixtures/** protecting another path is legal', () => {
    assert.deepEqual(errorsOf(FAITHFUL, (d) => { d.scope.allowed_changes = ['lib/serializer.js', 'test/*.test.js']; }), []);
    assert.deepEqual(errorsOf(FAITHFUL, (d) => { d.scope.protected_paths = ['package.json', 'test/fixtures/**']; }), []);
  });
});

describe('10674 F-b: missing test-writing criteria cannot be disguised', () => {
  test('the requested tests as "context" with no criterion: rejected', () => {
    const errors = errorsOf(FAITHFUL, (d) => { d.acceptance_criteria.pop(); d.requirements[5] = { id: 'R-6', passage_ids: ['P6'], disposition: 'context', reason: 'tests are context' }; });
    assert.match(errors.join('\n'), /P6 "Add node:test cases in test\/asNumber\.test\.js\." asks to add tests in test\/asNumber\.test\.js: a criterion covering that requirement must require adding them, bound with "adds_tests"/);
  });
  test('a criterion that merely cites P6 and makes an unrelated check pass: rejected', () => {
    const errors = errorsOf(FAITHFUL, (d) => {
      const ac = d.acceptance_criteria[5]; delete ac.adds_tests; ac.criterion = 'asNumber("-7") returns -7.';
      d.checks.push({ id: 'CHK-9', ac_id: 'AC-6', adapter: 'call_returns', params: { module: 'lib/serializer.js', export: 'asNumber', args: ['-7'], expect: -7 } });
    });
    assert.match(errors.join('\n'), /asks to add tests in test\/asNumber\.test\.js: a criterion covering that requirement must require adding them/);
  });
  test('relabelling the test criterion non_behavioral so the judge decides it: rejected (with or without adds_tests)', () => {
    assert.match(errorsOf(FAITHFUL, (d) => { delete d.acceptance_criteria[5].adds_tests; d.acceptance_criteria[5].kind = 'non_behavioral'; }).join('\n'), /asks to add tests in test\/asNumber\.test\.js/);
    assert.match(errorsOf(FAITHFUL, (d) => { d.acceptance_criteria[5].kind = 'non_behavioral'; }).join('\n'), /AC-6 requires adding tests, which is decided from the test run: it cannot be non_behavioral/);
  });
  test('adds_tests is literal files that the scope allows: globs, protected or unallowed files are rejected', () => {
    assert.match(errorsOf(FAITHFUL, (d) => { d.acceptance_criteria[5].adds_tests = { files: ['test/**'] }; }).join('\n'), /AC-6 adds_tests must be \{ "files": \[/);
    assert.match(errorsOf(FAITHFUL, (d) => { d.acceptance_criteria[5].adds_tests = { files: ['test/other.test.js'] }; }).join('\n'), /AC-6 adds tests in test\/other\.test\.js, but scope\.allowed_changes does not allow changing it/);
  });
  test('the location-only passage: linked to the behaviour criteria (faithful) or "context" with a location-only reason; never auto-marked', () => {
    assert.deepEqual(errorsOf(FAITHFUL), []);
    const ctx = errorsOf(FAITHFUL, (d) => { for (const ac of d.acceptance_criteria) ac.requirement_ids = ac.requirement_ids.filter((x) => x !== 'R-1'); d.requirements[0] = { id: 'R-1', passage_ids: ['P1'], disposition: 'context', reason: 'location only: the file the change belongs in' }; });
    assert.deepEqual(ctx, []);
    const none = errorsOf(FAITHFUL, (d) => { for (const ac of d.acceptance_criteria) ac.requirement_ids = ac.requirement_ids.filter((x) => x !== 'R-1'); });
    assert.match(none.join('\n'), /requirement R-1 "In lib\/serializer\.js," is not covered by any acceptance criterion/, 'QB does not mark it context on its own');
  });
  test('the prompt states the scope, location and adds_tests rules, and its example no longer protects test/**', () => {
    const sys = fs.readFileSync(path.join(__dirname, '..', '..', 'intent', 'prompts', 'system.md'), 'utf8');
    assert.match(sys, /Never protect a path you allow/);
    assert.match(sys, /Protect a path only when the request says not to change it .*it never protects a path\./);
    assert.match(sys, /"adds_tests": \{ "files": \["test\/x\.test\.js"\] \}/);
    assert.match(sys, /an instruction such as "Add tests in …" never is/);
    assert.doesNotMatch(sys, /"protected_paths": \["test\/\*\*"\]/);
  });
});

describe('10674 F-c: preservation evidence is real named-test evidence', () => {
  test('diagnosis first, on the exact saved AC-6: it was bound (preserves.tests) although the 4ed4be5 patterns did not match its wording; the defect is its binding', () => {
    const { isPreservationCriterion, PRESERVATION_PATTERNS } = load.preservation();
    const d = JSON.parse(REPAIRED);
    const ac6 = d.acceptance_criteria.find((a) => a.id === 'AC-6');
    const ac7 = d.acceptance_criteria.find((a) => a.id === 'AC-7');
    assert.equal(ac6.criterion, 'Existing tests in test/asNumber.test.js still pass.');
    // Reproduced with the exact text: the 4ed4be5 pattern list (its first 8 entries) does NOT match
    // "Existing tests in <file> still pass" (it stops at "tests in"). The model bound preserves.tests on
    // its own, so no validator error was missing for AC-6; its binding was the defect.
    assert.equal(PRESERVATION_PATTERNS.slice(0, 8).some((p) => p.test(ac6.criterion)), false);
    assert.equal(isPreservationCriterion(ac6.criterion), true, 'recognised now');
    assert.deepEqual(ac6.preserves, { tests: ['test/asNumber.test.js'] });
    assert.deepEqual(d.checks.filter((k) => k.ac_id === 'AC-6').map((k) => [k.adapter, k.params.args]), [['call_returns', ['-7']]]);
    // AC-7's wording needed recognition: now a preservation claim.
    assert.equal(ac7.criterion, 'No other tests regress.');
    assert.equal(isPreservationCriterion(ac7.criterion), true);
  });
  test('the smoke\'s bindings are rejected: an edited preserved file, value checks on a test-suite claim, a glob for "no other tests regress"', () => {
    const c = contractOf(REPAIRED);
    const errors = load.preservation().preservationErrors(c).join('\n');
    assert.match(errors, /AC-6 preserves test\/asNumber\.test\.js, which the request asks to change: passing afterwards cannot show that its existing tests were kept/);
    assert.match(errors, /AC-6 claims tests still pass, but is bound to CHK-6 \(call_returns\): a value check cannot show that a test suite passed/);
    assert.match(errors, /AC-7 preserves\.tests "test\/\*\*" is a pattern: name the test files/);
    assert.match(errors, /AC-7 claims tests still pass, but is bound to CHK-7 \(call_returns\)/);
  });
  test('"No other tests regress" with no binding is a preservation claim needing named tests (it used to be decided by a value check)', () => {
    const errors = errorsOf(FAITHFUL, (d) => { d.acceptance_criteria.push({ id: 'AC-7', criterion: 'No other tests regress.', kind: 'behavioral', requirement_ids: ['R-6'] }); });
    assert.match(errors.join('\n'), /AC-7 is a preservation criterion: name the tests it preserves/);
  });
  test('still allowed: numeric behaviour preserved by numeric checks, and an interface claim with checks plus named tests the task does not edit', () => {
    assert.deepEqual(errorsOf(FAITHFUL), [], 'AC-3…AC-5 keep 0, "0" and valid numeric strings with call_returns checks');
    const ok = errorsOf(FAITHFUL, (d) => {
      d.acceptance_criteria.push({ id: 'AC-7', criterion: 'Serializer stays backward compatible: test/serializer.test.js still passes.', kind: 'behavioral', requirement_ids: ['R-5'], preserves: { tests: ['test/serializer.test.js'] } });
    });
    assert.deepEqual(ok, []);
    const iface = errorsOf(FAITHFUL, (d) => {
      d.acceptance_criteria.push({ id: 'AC-7', criterion: 'The asNumber export stays backward compatible.', kind: 'behavioral', requirement_ids: ['R-5'], preserves: { tests: ['test/serializer.test.js'] } });
      d.checks.push({ id: 'CHK-9', ac_id: 'AC-7', adapter: 'module_exports', params: { module: 'lib/serializer.js', export: 'asNumber', type: 'function' } });
    });
    assert.deepEqual(iface, [], 'an interface (not test-suite) claim may bind checks');
  });
});

describe('10674: the faithful contract and its criterion-to-evidence mapping', () => {
  test('the faithful draft finalizes in one call; every criterion maps to evidence QB can produce', async () => {
    const { s, calls } = await compileWith([FAITHFUL]);
    assert.equal(calls, 1);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    const c = s.contract;
    const evidence = Object.fromEntries(c.acceptance_criteria.map((ac) => [ac.id,
      ac.adds_tests ? `adds_tests:${ac.adds_tests.files.join(',')}` : c.checks.filter((k) => k.ac_id === ac.id).map((k) => `${k.adapter}(${JSON.stringify(k.params.args)})`).join(' ')]));
    assert.deepEqual(evidence, {
      'AC-1': 'call_throws([""])',
      'AC-2': 'call_throws(["   "])',
      'AC-3': 'call_returns([0])',
      'AC-4': 'call_returns(["0"])',
      'AC-5': 'call_returns(["12.5"]) call_returns(["-7"]) call_returns([" 123 "])',
      'AC-6': 'adds_tests:test/asNumber.test.js',
    });
    assert.deepEqual(c.scope, { allowed_changes: ['lib/serializer.js', 'test/asNumber.test.js'], protected_paths: ['package.json'] });
  });

  const L = (o) => JSON.stringify(o) + '\n';
  const report = (tests) => L({ type: 'qb:start', format: 'qb-node-test-events/1' })
    + tests.map(([file, name, ok]) => L({ type: ok ? 'test:pass' : 'test:fail', name, nesting: 0, path: [], file: `/verify/${file}`, kind: 'test', skip: false, todo: false, failureType: ok ? null : 'testCodeFailure', ...(ok ? {} : { error: 'boom' }) })).join('')
    + L({ type: 'test:summary', file: null, counts: { tests: tests.length, passed: tests.filter((t) => t[2]).length, failed: tests.filter((t) => !t[2]).length, cancelled: 0, skipped: 0, todo: 0 }, success: tests.every((t) => t[2]) })
    + L({ type: 'qb:end' });
  const exec = (files, tests, state = 'completed') => ({ id: 'e', status: 'completed', diff: files.map((f) => `diff --git a/${f} b/${f}\n`).join(''), changes: files.map((f) => ({ file: f, status: 'M' })),
    sandbox: { verification: state === 'timeout' ? { status: 'ran', state, exit_code: 137, output: '', report: null } : { status: 'ran', state: tests.every((t) => t[2]) ? 'completed' : 'execution_error', exit_code: tests.every((t) => t[2]) ? 0 : 1, output: '', report: report(tests) } } });
  const approved = () => load.state().approve(contractOf(FAITHFUL), { via: 'test' });
  const decide = async (execution) => {
    const r = await load.verifier().verify(approved(), null, execution, { noLlm: true });
    return r.criteria_results.find((x) => x.id === 'AC-6');
  };

  test('adds_tests is decided from the change set and the test run, never by the judge', async () => {
    const both = ['lib/serializer.js', 'test/asNumber.test.js'];
    // 10677 (2): "changed + passing" alone is no longer enough: a diff with no new test case is not met
    // (the full witness is in kan106-10677-repair-evidence.test.js).
    const headerOnly = await decide(exec(both, [['test/asNumber.test.js', 'empty string throws', true]]));
    assert.deepEqual([headerOnly.met, headerOnly.method], [false, 'test-runner+change-set']);
    assert.match(headerOnly.evidence, /test\/asNumber\.test\.js: changed; 1 passed, 0 failed; the diff of test\/asNumber\.test\.js adds no code/);   // 10690: wording
    const unchanged = await decide(exec(['lib/serializer.js'], [['test/asNumber.test.js', 'old test', true]]));
    assert.equal(unchanged.met, false);
    assert.match(unchanged.evidence, /not changed by the task: test\/asNumber\.test\.js/);
    const failing = await decide(exec(both, [['test/asNumber.test.js', 'empty string throws', false]]));
    assert.equal(failing.met, false);
    const unusable = await decide(exec(both, [], 'timeout'));
    assert.equal(unusable.met, null, 'an unusable run proves nothing');
  });
  test('a preserved test file that the task edited is not evidence that its existing tests were kept', () => {
    const { decidePreservation } = load.preservation();
    const classified = { outcome: 'passed', byFile: { 'test/parser.test.js': { passed: 3, failed: 0, skipped: 0 } } };
    const ac = { id: 'AC-2', criterion: 'Existing parser tests still pass', preserves: { tests: ['test/parser.test.js'] } };
    assert.equal(decidePreservation(ac, classified).met, true, 'unchanged behaviour without a change set');
    const r = decidePreservation(ac, classified, { changes: [{ file: 'test/parser.test.js', status: 'M' }] });
    assert.equal(r.met, false);
    assert.match(r.evidence, /edited by the task: test\/parser\.test\.js/);
  });
  test('old contract and hash behaviour: no adds_tests → the approved content and hash are unchanged (pinned at 4ed4be5)', () => {
    const { contractHash, approvedContent } = load.state();
    const c = { goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'x returns 1', kind: 'behavioral', requirement_ids: ['R-1'] },
      { id: 'AC-2', criterion: 'existing tests still pass', kind: 'behavioral', requirement_ids: ['R-1'], preserves: { tests: ['test/a.test.js'] } }],
    requirements: [{ id: 'R-1', quote: 'q' }], checks: [], scope: { allowed_changes: ['src/x.js'], protected_paths: [] } };
    assert.equal(contractHash(c), '43191be5331ac35d72ddf81912956b7009fd52afa74673eb7229e37428a2b1a9');
    assert.ok(!('adds_tests' in approvedContent(c).acceptance_criteria[0]));
    const withTests = JSON.parse(JSON.stringify(c));
    withTests.acceptance_criteria[0].adds_tests = { files: ['test/x.test.js'] };
    assert.notEqual(contractHash(withTests), contractHash(c), 'adds_tests is part of the approved oracle');
  });
});

describe('10674 F-d: L1 time limits (experimental Qwen profile, enforced, monotonic)', () => {
  test('the profile is explicit and experimental: 240 s per call, 420 s for L1; no default changes', () => {
    const { l1Budget, L1_PROFILES } = load.budget();
    const saved = { b: process.env.QB_L1_BUDGET_MS, c: process.env.QB_MODEL_CALL_TIMEOUT_MS, p: process.env.QB_L1_PROFILE };
    try {
      delete process.env.QB_L1_BUDGET_MS; delete process.env.QB_MODEL_CALL_TIMEOUT_MS; delete process.env.QB_L1_PROFILE;
      assert.deepEqual(L1_PROFILES['qwen-14b-experimental'].per_call_ms, 240_000);
      assert.equal(L1_PROFILES['qwen-14b-experimental'].experimental, true);
      assert.deepEqual(l1Budget(), { ms: 360_000, source: 'provisional_default', enforced: false, per_call_ms: 180_000, profile: null }, 'no profile: unchanged, not enforced');
      assert.deepEqual(l1Budget({ profile: 'qwen-14b-experimental' }), { ms: 420_000, source: 'profile qwen-14b-experimental', enforced: true, per_call_ms: 240_000, profile: 'qwen-14b-experimental' });
      process.env.QB_L1_PROFILE = 'qwen-14b-experimental';
      assert.equal(l1Budget().ms, 420_000);
      assert.throws(() => l1Budget({ profile: 'fast' }), /unknown L1 profile "fast"/);
      const { validateRunOptions } = require('../../lib/run-options');
      assert.match(validateRunOptions({ agent: 'dry-run', repo: require('os').tmpdir(), maxRetries: '3', l1Profile: 'fast' }, 'x').errors.join('\n'), /--l1-profile must be one of qwen-14b-experimental/);
    } finally {
      for (const [k, v] of [['QB_L1_BUDGET_MS', saved.b], ['QB_MODEL_CALL_TIMEOUT_MS', saved.c], ['QB_L1_PROFILE', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  const PROFILE = { ms: 420_000, source: 'profile qwen-14b-experimental', enforced: true, per_call_ms: 240_000, profile: 'qwen-14b-experimental' };

  test('fake clock: each call gets min(per-call cap, remaining L1 time); the repair gets only what is left', async () => {
    let clock = 0;
    const { s } = await compileWith([SYNTHETIC_FIRST, FAITHFUL], { session: { now: () => clock, l1Budget: PROFILE }, onCall: (k) => { clock += k === 0 ? 400_000 : 15_000; } });
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.timings.calls.map((c) => [c.kind, c.ms, c.limit_ms]), [['initial', 400_000, 240_000], ['repair', 15_000, 20_000]]);
    assert.equal(s.timings.l1_ms, 415_000);
    assert.deepEqual({ ...s.timings.l1_budget, exhausted: s.timings.l1_budget.exhausted }, { ...PROFILE, exhausted: false });
  });
  test('10812: the RECORDED first draft (eba7015e, protects test/** for behaviour constraints) is blocked when the correction drops it; the same limits apply', async () => {
    for (const l1Budget of [PROFILE, { ms: 360_000, source: 'provisional_default', enforced: false, per_call_ms: 180_000, profile: null }]) {
      let clock = 0;
      const { s, calls } = await compileWith([INITIAL, FAITHFUL], { session: { now: () => clock, l1Budget }, onCall: (k) => { clock += l1Budget.enforced ? (k === 0 ? 400_000 : 15_000) : 300_000; } });
      assert.equal(calls, 2);
      assert.equal(s.state, 'invalid');
      assert.match(s.errors.join('\n'), /protected path "test\/\*\*" enforces constraint 0 .*a correction may not remove it/);
      assert.deepEqual(s.timings.calls.map((c) => c.limit_ms), l1Budget.enforced ? [240_000, 20_000] : [180_000, 180_000]);
    }
  });
  test('fake clock: once L1 time is spent no repair starts; the timeout reason is clear and the timings and the rejected draft are kept', async () => {
    let clock = 0;
    const { error, calls } = await compileWith([INITIAL, FAITHFUL], { session: { now: () => clock, l1Budget: PROFILE }, onCall: () => { clock += 430_000; } });
    assert.equal(calls, 1, 'no repair call after exhaustion (one repair at most, and none here)');
    assert.equal(error.code, 'DEADLINE');
    assert.equal(error.kind, 'l1');
    assert.match(error.message, /L1 budget \(420000ms, profile qwen-14b-experimental\) exhausted before the repair call/);
    assert.equal(error.recovery.attempted, false);
    assert.equal(error.recovery.failed.kind, 'l1_budget');
    assert.equal(error.recovery.rejected[0].kind, 'invalid');
    assert.equal(error.l1_timings.initial_call_ms, 430_000);
    assert.equal(error.l1_timings.l1_budget.exhausted, true);
  });
  test('real cancellation: a hanging call is aborted when the L1 budget runs out (DeadlineError kind "l1")', { timeout: 10_000 }, async () => {
    const m = mockFetch(() => new Promise(() => {}));
    const t0 = Date.now();
    try {
      await assert.rejects(load.session().compileIntent(REQUEST, { l1Budget: { ms: 80, source: '--l1-budget', enforced: true, per_call_ms: 180_000, profile: null } }),
        (e) => e.code === 'DEADLINE' && e.kind === 'l1' && /exhausted during the first draft call/.test(e.message) && e.l1_timings.calls[0].outcome === 'l1_budget_exhausted');
    } finally { m.restore(); }
    assert.ok(Date.now() - t0 < 5_000);
  });
  test('an enclosing run deadline also bounds the call limit', async () => {
    const budget = load.budget();
    budget.startRun({ deadlineMs: 50_000 });
    try {
      const { s } = await compileWith([FAITHFUL], { session: { l1Budget: PROFILE } });
      assert.ok(s.timings.calls[0].limit_ms <= 50_000, String(s.timings.calls[0].limit_ms));
    } finally { budget.endRun(); }
  });
  test('an unenforced (provisional) budget never cancels; the old per-call limit applies', async () => {
    let clock = 0;
    const { s } = await compileWith([SYNTHETIC_FIRST, FAITHFUL], { session: { now: () => clock, l1Budget: { ms: 360_000, source: 'provisional_default', enforced: false, per_call_ms: 180_000, profile: null } }, onCall: () => { clock += 300_000; } });
    assert.equal(s.state, 'finalized');
    assert.deepEqual(s.timings.calls.map((c) => c.limit_ms), [180_000, 180_000]);
  });
  test('warm-up is opt-in, its own recorded call, inside L1 time; model load time is recorded where Ollama reports it', async () => {
    let clock = 0;
    const { s, urls } = await compileWith([FAITHFUL], { session: { now: () => clock, l1Budget: PROFILE, warmup: true }, onWarmup: () => { clock += 90_000; }, onCall: () => { clock += 100_000; }, loadNs: [0] });
    assert.equal(s.state, 'finalized');
    assert.ok(urls[0].endsWith('/api/generate'));
    assert.deepEqual(s.timings.calls.map((c) => [c.kind, c.ms, c.load_ms]), [['warmup', 90_000, 4200], ['initial', 100_000, 0]]);
    assert.equal(s.timings.warmup_ms, 90_000);
    assert.equal(s.timings.l1_ms, 190_000, 'the warm-up is never hidden from the user\'s wait');
    const off = await compileWith([FAITHFUL]);
    assert.ok(!off.urls.some((u) => u.endsWith('/api/generate')), 'no warm-up unless asked');
    assert.equal(off.s.timings.warmup_ms, null);
  });
  test('no keep_alive or other Ollama setting is sent', async () => {
    const m = mockFetch((url) => (url.endsWith('/api/generate') ? { response: '' } : ollamaReply(FAITHFUL)));
    try {
      await load.session().compileIntent(REQUEST, { warmup: true });
      for (const c of m.calls) assert.ok(!('keep_alive' in JSON.parse(c.init.body)), c.url);
    } finally { m.restore(); }
  });
});

describe('10674 item 5: bench/l1-eval.js saves timings and the profile identity', () => {
  test('a profile or warm-up changes the run identity (never pooled with earlier rows); without them the identity is as before', () => {
    const ev = require('../../bench/l1-eval');
    const score = require('../../bench/l1-eval/score');
    const before = ev.runIdentity();
    assert.ok(!('l1_profile' in before.settings) && !('l1_warmup' in before.settings));
    const prof = ev.runIdentity({ l1Budget: PROFILE_FOR_EVAL, warmup: true });
    assert.deepEqual([prof.settings.l1_profile, prof.settings.l1_budget_ms, prof.settings.l1_per_call_ms, prof.settings.l1_budget_enforced, prof.settings.l1_warmup], ['qwen-14b-experimental', 420_000, 240_000, true, true]);
    assert.notEqual(score.groupKey({ model: 'm', run: before }), score.groupKey({ model: 'm', run: prof }));
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'l1-eval.js'), 'utf8');
    assert.match(src, /format: 'qb-l1-eval-trial\/3'/);
    assert.match(src, /timings: result\?\.timings \|\| error\?\.l1_timings \|\| null/);
  });
});
const PROFILE_FOR_EVAL = { ms: 420_000, source: 'profile qwen-14b-experimental', enforced: true, per_call_ms: 240_000, profile: 'qwen-14b-experimental' };
