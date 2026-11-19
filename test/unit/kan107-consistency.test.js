/**
 * KAN-107 (senior 10766, approved for offline implementation in 10771): request-to-check consistency.
 * QB must not silently replace a supported customer example with a different check, must retain stated rules,
 * and must disclose what it does not check. OFFLINE: the model is faked, QB_OLLAMA_URL points at a dead port.
 *
 * Pre-fix evidence (the gap): at d19865e every negative fixture below was `finalized` by the validators of
 * that time (docs/research/kan107/red-evidence.md). This file now requires rejection.
 *
 * Module: intent/request-examples.js (parseLiteral, extractExamples, exampleErrors, exampleMapping, LIMITS),
 * wired into intent/contract-state.js, intent/staged.js and intent/oracle-view.js.
 *
 * The KAN-106 eight requests (S1-S6, U1, U2) appear only as KNOWN REGRESSIONS (their outcomes have been
 * seen), never as fresh validation.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { contractFromObject } = require('../../intent/compiler');
const { contractState, approve, approvalState } = require('../../intent/contract-state');
const { groundApi, contractGrounding } = require('../../intent/api-grounding');
const { draft, fn, throwsFn, method } = require('../fixtures/kan107/build');

process.env.QB_OLLAMA_URL = 'http://127.0.0.1:9';   // never a real model, even by accident
const RX = () => require('../../intent/request-examples');
const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');
const K104 = path.join(__dirname, '..', 'fixtures', 'kan104');
const read104 = (f) => fs.readFileSync(path.join(K104, f), 'utf8');

function makeDir(files, prefix = 'kan107-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries({ 'package.json': '{"name":"k107","type":"commonjs"}', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** QB's REAL static grounding of a fixture repository, as the compilers attach it (never model-supplied). */
function grounded(request, files) {
  const r = makeDir(files);
  try { return contractGrounding(groundApi(r.dir, request)); } finally { r.cleanup(); }
}
/** The contract as a producer hands it to contractState: normalized, then QB's own grounding attached. */
function contract(request, raw, grounding = null) {
  const c = contractFromObject(raw, request);
  if (grounding) c.api_grounding = grounding;
  return c;
}
const stateOf = (request, raw, g) => contractState(contract(request, raw, g));
const errorsOf = (request, raw, g) => { const s = stateOf(request, raw, g); return s.state === 'invalid' ? s.errors.join('\n') : `(state ${s.state})`; };
/** The REAL check runner against fixture source files (checks unchanged). */
function runChecks(checks, files) {
  const r = makeDir(files, 'kan107-run-');
  try {
    const out = path.join(r.dir, 'results.json');
    const p = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: r.dir, checks }), encoding: 'utf8',
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 60_000 });
    assert.equal(p.status, 0, p.stderr);
    return Object.fromEntries(JSON.parse(fs.readFileSync(out, 'utf8')).results.map((x) => [x.id, x.status]));
  } finally { r.cleanup(); }
}

// Fixture sources (hand-written for KAN-107).
const SRC = {
  formatter: "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  setSeparator (s) {\n    this.separator = s\n  }\n\n  join (list) {\n    if (list.length === 0) return ''\n    return list.join(this.separator)\n  }\n}\n",
  formatterBase: "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  join (list) {\n    if (list.length === 0) return undefined\n    return list.join(this.separator)\n  }\n}\n",
  users: "'use strict'\n\nmodule.exports = class UserRepo {\n  constructor (db) {\n    this.db = db\n  }\n\n  find (id) {\n    const row = this.db.get(id)\n    if (!row) throw new Error('unknown id')\n    return row\n  }\n}\n",
  list: "'use strict'\nfunction first (xs) { return xs.length ? xs[0] : null }\nmodule.exports = { first }\n",
  text: "'use strict'\nfunction joinAll (list) { return list.join(',') }\nmodule.exports = { joinAll }\n",
  grid: "'use strict'\nfunction flat (rows) { return rows.flat() }\nmodule.exports = { flat }\n",
  round: "'use strict'\n\nfunction roundTo (n, places) {\n  const f = 10 ** places\n  return Math.round(n * f) / f\n}\n\nmodule.exports = { roundTo }\n",
  math: "'use strict'\nfunction add (a, b) { return a + b }\nmodule.exports = { add }\n",
  mathPercent: "'use strict'\nfunction add (a, b) { return a + b }\nfunction percent (part, whole) {\n  if (whole === 0) throw new Error('whole must not be zero')\n  return Math.round(part / whole * 100)\n}\nmodule.exports = { add, percent }\n",
  env: "'use strict'\nconst TRUE = ['true', '1', 'yes']\nfunction parseBool (s) { return TRUE.includes(String(s)) }\nmodule.exports = { parseBool }\n",
  envBase: "'use strict'\nfunction parseBool (s) { return s === 'true' }\nmodule.exports = { parseBool }\n",
  defaults: "'use strict'\nmodule.exports = { debug: 'false' }\n",
};

// ── literals: no eval; nesting and types preserved; ONE set of limits (correction E) ──
describe('KAN-107 literals and limits (decision 2, correction E)', () => {
  test('JSON-like literals parse without eval; nesting and types are preserved', () => {
    const { parseLiteral } = RX();
    assert.deepEqual(parseLiteral('[]').value, []);
    assert.deepEqual(parseLiteral('["a", "b"]').value, ['a', 'b']);
    assert.deepEqual(parseLiteral("['a', 'b']").value, ['a', 'b']);
    assert.deepEqual(parseLiteral('[[1, 2], [3]]').value, [[1, 2], [3]]);
    assert.deepEqual(parseLiteral('-2.5').value, -2.5);
    assert.deepEqual(parseLiteral('"1"').value, '1');
    assert.notDeepEqual(parseLiteral('"1"').value, parseLiteral('1').value, 'a string is not a number');
    assert.deepEqual(parseLiteral('null').value, null);
    assert.deepEqual(parseLiteral('"a\\"b"').value, 'a"b');
  });
  test('unsupported literals are refused with a reason, never coerced or flattened (objects: Q3)', () => {
    const { parseLiteral } = RX();
    for (const [text, why] of [['[[[[1]]]]', /depth/], ['{ a: 1 }', /object/], ['`a${b}`', /template/], ['x', /identifier|variable/], ['1 + 2', /expression/], ['undefined', /undefined|not JSON/],
      [`[${Array(17).fill(0).join(', ')}]`, /items/], [`"${'x'.repeat(1100)}"`, /bytes/]]) {
      const r = parseLiteral(text);
      assert.equal(r.ok, false, text);
      assert.match(r.reason, why, text);
    }
  });
  test('the limits are defined per ARGUMENT value (depth), separately from the argument list (count, total bytes)', () => {
    const { LIMITS, argsErrors } = RX();
    assert.deepEqual({ depth: LIMITS.depth, items: LIMITS.items, args: LIMITS.args, bytes: LIMITS.bytes }, { depth: 3, items: 16, args: 8, bytes: 1024 });
    assert.deepEqual(argsErrors([[[[1]]]]), [], 'one argument of depth 3');
    assert.match(argsErrors([[[[[1]]]]]).join(), /depth/, 'one argument of depth 4');
    assert.deepEqual(argsErrors([[[1]], [[2]], [[3]]]), [], 'three arguments, each depth 2: the outer list is not a nesting level');
    assert.match(argsErrors(Array(9).fill(1)).join(), /arguments/);
    assert.match(argsErrors(['x'.repeat(600), 'y'.repeat(600)]).join(), /bytes/);
    assert.ok(LIMITS.bytes <= 4096, 'never looser than the registry cap (verify/checks/registry.js: 4 KiB)');
  });
  test('the SAME limits in the staged fact schema + validateFacts as in parsing (accept and refuse alike)', () => {
    const { factSchema, validateFacts } = require('../../intent/staged');
    const { argsErrors } = RX();
    const schema = factSchema({ requirementId: 'R-2', calls: ['f (lib/f.js)'], fragments: 0 });
    const reply = (args, expected = null) => ({ cases: [{ requirement: 'R-2', call: 'f (lib/f.js)', args, outcome: 'returns', expected, error_fragment: null }] });
    const samples = [[[]], [['a', 'b']], [[[1, 2], [3]]], [[[[1]]]], [[[[[1]]]]], [{ a: 1 }], [Array(16).fill(0)], [Array(17).fill(0)], Array(8).fill(1), Array(9).fill(1), ['x'.repeat(600), 'y'.repeat(600)]];
    for (const args of samples) {
      const parsing = argsErrors(args).length === 0;
      const staged = validateFacts(schema, reply(args)).length === 0;
      assert.equal(staged, parsing, `args ${JSON.stringify(args).slice(0, 60)}: parsing ${parsing}, staged ${staged}`);
    }
    assert.notDeepEqual(validateFacts(schema, reply([1], { a: 1 })), [], 'an object expected value is refused, not coerced');
  });
  test('round trip through the REAL check runner: array, nested, empty-array and method arguments at the limits run as ONE argument', () => {
    const at = Array(16).fill(0);
    const checks = [
      { id: 'A', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/list.js', export: 'first', args: [[]], expect: null } },
      { id: 'B', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/list.js', export: 'first', args: [at], expect: 0 } },
      { id: 'C', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/text.js', export: 'joinAll', args: [['a', 'b']], expect: 'a,b' } },
      { id: 'D', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/grid.js', export: 'flat', args: [[[1, 2], [3]]], expect: [1, 2, 3] } },
      { id: 'E', ac_id: 'AC-1', adapter: 'call_sequence', params: { module: 'lib/formatter.js', export: 'default', instances: { s: { construct: 'new', args: [] } }, steps: [{ on: 's', method: 'join', args: [[]], expect: '' }, { on: 's', method: 'join', args: [['a', 'b']], expect: 'a,b' }] } },
      // the flattened shapes really are different calls:
      { id: 'F', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/list.js', export: 'first', args: [], expect: null } },
      { id: 'G', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/text.js', export: 'joinAll', args: ['a', 'b'], expect: 'a,b' } },
    ];
    const { validateChecks } = require('../../verify/checks/registry');
    assert.equal(validateChecks(checks, [{ id: 'AC-1' }]).rejected.length, 0);
    assert.deepEqual(runChecks(checks, { 'lib/list.js': SRC.list, 'lib/text.js': SRC.text, 'lib/grid.js': SRC.grid, 'lib/formatter.js': SRC.formatter }),
      { A: 'pass', B: 'pass', C: 'pass', D: 'pass', E: 'pass', F: 'fail', G: 'fail' });
  });
});

// ── extraction from the request text only (Q1, decision 4, 5; correction A) ──
describe('KAN-107 extraction', () => {
  test('call examples with returns / returning / throws; the first value after the verb; keep examples', () => {
    const { examples } = RX().extractExamples('In lib/temp.js, make toF(100) return 212 instead of 211. Keep toF(0) returning 32.');
    assert.deepEqual(examples.map((e) => [e.name, e.args, e.outcome, e.expected, e.kept]), [['toF', [100], 'returns', 212, false], ['toF', [0], 'returns', 32, true]]);
    assert.ok(examples.every((e) => typeof e.excerpt === 'string' && Array.isArray(e.span) && e.passage_id));
  });
  test('Q1 contrast 1: "make greeting() return \'x\'" IS a zero-argument example', () => {
    const { examples } = RX().extractExamples("In lib/greet.js, make greeting() return 'x'.");
    assert.deepEqual(examples.map((e) => [e.name, e.args, e.expected]), [['greeting', [], 'x']]);
  });
  test('Q1 contrast 2: a bare locator "Update greeting() … so greeting("Arshad") returns …" is a name mention', () => {
    const { examples } = RX().extractExamples(read104('request.txt').trim());
    assert.deepEqual(examples.map((e) => [e.name, e.args, e.expected]), [['greeting', ['Arshad'], 'Hello, Arshad!'], ['greeting', [], 'Hello from Node Project JS!']]);
  });
  test('Q1 contrast 3: conditional prose "make join() return \'\' for an empty array" is unsupported prose, not zero arguments', () => {
    const r = RX().extractExamples("In lib/formatter.js, make join() return '' for an empty array.");
    assert.deepEqual(r.examples, []);
    assert.ok(r.unsupported.some((u) => /join\(\)/.test(u.excerpt) && /conditional/.test(u.reason)), JSON.stringify(r.unsupported));
  });
  test('prose values and U1-style conditions are unsupported (recorded, no error, never certified)', () => {
    for (const req of ['In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.',
      'In lib/formatter.js, make Formatter.join() return an empty string for an empty array instead of undefined.']) {
      const r = RX().extractExamples(req);
      assert.deepEqual(r.examples, [], req);
      assert.ok(r.unsupported.length >= 1, req);
    }
  });
  test('variables and expressions as arguments are unsupported (recorded, never guessed)', () => {
    const r = RX().extractExamples('In lib/math.js, make percent(part, whole) return part / whole * 100.');
    assert.deepEqual(r.examples, []);
    assert.ok(r.unsupported.some((u) => /percent/.test(u.excerpt)));
  });
  test('object literal examples are recognized and reported unsupported (Q3)', () => {
    const r = RX().extractExamples('In lib/cfg.js, make merge({ a: 1 }) return 1.');
    assert.deepEqual(r.examples, []);
    assert.ok(r.unsupported.some((u) => /object/.test(u.reason)));
  });
  test('correction A: a conditional message requirement keeps its condition and binds it to a request-derived parameter (provenance)', () => {
    const req = 'In lib/math.js, create and export a function percent(part, whole) that returns part / whole * 100 rounded to the nearest whole number, for example percent(1, 3) returns 33. When whole is 0 it must throw an error whose message includes "whole must not be zero".';
    const r = RX().extractExamples(req);
    assert.equal(r.messages.length, 1);
    const m = r.messages[0];
    assert.deepEqual([m.fragment, m.mode, m.name], ['whole must not be zero', 'includes', 'percent']);
    assert.deepEqual([m.condition.text, m.condition.param, m.condition.index, m.condition.value], ['When whole is 0', 'whole', 1, 0]);
    assert.match(req.slice(...m.condition.signature_span), /percent\(part, whole\)/);
    assert.equal(req.slice(...m.span).includes('whole must not be zero'), true);
  });
  test('correction A: "message includes" and "message is" are distinguished', () => {
    const { examples } = RX().extractExamples('In lib/f.js, make f(0) throw an error whose message includes "zero". Keep f(-1) throwing an error whose message is "negative".');
    assert.deepEqual(examples.map((e) => [e.args, e.message && e.message.mode, e.message && e.message.fragment]), [[[0], 'includes', 'zero'], [[-1], 'equals', 'negative']]);
  });
  test('an error CLASS is recorded as such and never treated as message text', () => {
    const { examples } = RX().extractExamples('In src/port.js, make parsePort("70000") throw a RangeError.');
    assert.equal(examples[0].outcome, 'throws');
    assert.equal(examples[0].error_class, 'RangeError');
    assert.equal(examples[0].message, null);
  });
  test('a bare DESCRIPTION is not a requirement (QB-30 PW-01: the bug report states the CURRENT value): unsupported, never enforced', () => {
    const r = RX().extractExamples("Warnings don't interpolate falsy values. With const w = createWarning({ name: 'W' }), w.format(0) returns 'count=%d' instead of 'count=0'. Fix it.");
    assert.deepEqual(r.examples, []);
    assert.ok(r.unsupported.some((u) => /w\.format\(0\)/.test(u.excerpt) && /description/.test(u.reason)), JSON.stringify(r.unsupported));
    assert.deepEqual(RX().extractExamples('In lib/temp.js, toF(100) should return 212.').examples.map((e) => e.expected), [212], 'should/must/still on the verb frames it as wanted');
  });
  test('a described current value next to the requested one: only the requested one is enforced', () => {
    const R = "In lib/w.js, f(0) returns 'bad' instead of 'good'. Make f(0) return 'good'.";
    const raw = draft(R, [{ criterion: "f(0) returns 'good'.", passages: ['P2', 'P3'], check: fn('lib/w.js', 'f', [0], 'good') }], { allowed: ['lib/w.js'] });
    assert.deepEqual(RX().extractExamples(R).examples.map((e) => e.expected), ['good']);
    assert.equal(stateOf(R, raw).state, 'finalized', errorsOf(R, raw));
  });
  test('general rules are kept as reviewable requirements, separate from the example (S1 / S5 shapes)', () => {
    const r = RX().extractExamples('In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".');
    assert.deepEqual(r.rules.map((x) => x.passage_id), ['P2']);
    assert.equal(r.examples.length, 1);
  });
  test('Q4: the small vague-qualifier list (regression-tested); stated behaviour is never flagged', () => {
    const flagged = ['In lib/round.js, make roundTo() handle negative numbers properly.', 'In lib/csv.js, make parse() work correctly with tabs.', 'In lib/load.js, make load() fail gracefully.', 'In lib/x.js, make run() behave as expected.'];
    const fine = ['In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.', 'In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.', 'In lib/slug.js, make slugify() turn each run of spaces into a single dash.', 'Add a clamp function to src/utils.js.'];
    for (const r of flagged) assert.equal(RX().extractExamples(r).underspecified.length, 1, r);
    for (const r of fine) assert.equal(RX().extractExamples(r).underspecified.length, 0, r);
  });
});

// ── the rule through contractState (legacy drafts, the correction, staged output and --contract-file all use it) ──
describe('KAN-107 consistency errors (decisions 1, 2, 3, 6; corrections A, C)', () => {
  const TEMP = 'In lib/temp.js, make toF(100) return 212. Keep toF(0) returning 32.';
  const PORT = 'In src/port.js, make parsePort("70000") throw a RangeError. Keep parsePort("8080") returning 8080.';
  const FIRST = 'In lib/list.js, make first([]) return null. Keep first([7, 8]) returning 7.';
  const JOINALL = 'In lib/text.js, make joinAll(["a", "b"]) return "a,b".';
  const FLAT = 'In lib/grid.js, make flat([[1, 2], [3]]) return [1, 2, 3].';
  const GREET = "In lib/greet.js, make greeting() return 'x'.";
  const F0 = 'In lib/f.js, make f(0) throw an error whose message includes "zero".';
  const PCT = 'In lib/math.js, create and export a function percent(part, whole) that returns part / whole * 100 rounded to the nearest whole number, for example percent(1, 3) returns 33. When whole is 0 it must throw an error whose message includes "whole must not be zero".';
  const pct = (...zeroChecks) => draft(PCT, [
    { criterion: 'percent(part, whole) returns part / whole * 100 rounded to the nearest whole number: percent(1, 3) returns 33.', passages: ['P2', 'P3'], check: fn('lib/math.js', 'percent', [1, 3], 33) },
    ...zeroChecks.map((k) => ({ criterion: `percent(${k.params.args.join(', ')}) throws an error whose message includes "whole must not be zero" (when whole is 0).`, passages: ['P4'], check: k }))], { allowed: ['lib/math.js'] });
  const firstOk = (extra = []) => draft(FIRST, [
    { criterion: 'first([]) returns null.', passages: ['P2'], check: fn('lib/list.js', 'first', [[]], null) },
    { criterion: 'first([7, 8]) still returns 7.', passages: ['P3'], check: fn('lib/list.js', 'first', [[7, 8]], 7) },
    ...extra], { allowed: ['lib/list.js'] });

  const negatives = [
    // [name, request, raw draft, expected error]
    ['KAN-104 historical greeting mismatch: greeting("test") expects "Hello, Arshad!"', read104('request.txt').trim(), JSON.parse(read104('contradictory-check-draft.json')), /greeting\("Arshad"\).*has no check with those arguments.*CHK-1/],
    ['return "Error" versus throw', PORT, draft(PORT, [
      { criterion: 'parsePort("70000") throws a RangeError.', passages: ['P2'], check: fn('src/port.js', 'parsePort', ['70000'], 'Error') },
      { criterion: 'parsePort("8080") still returns 8080.', passages: ['P3'], check: fn('src/port.js', 'parsePort', ['8080'], 8080) }], { allowed: ['src/port.js'] }), /CHK-1 contradicts the request's example parsePort\("70000"\) throws/],
    ['missing example: no check for toF(100)', TEMP, draft(TEMP, [
      { criterion: 'toF(100) returns 212.', passages: ['P2'] },
      { criterion: 'toF(0) still returns 32.', passages: ['P3'], check: fn('lib/temp.js', 'toF', [0], 32) }], { allowed: ['lib/temp.js'] }), /toF\(100\).*has no executable check/],
    ['Q1: the clear zero-argument example "make greeting() return \'x\'" has no check', GREET, draft(GREET, [
      { criterion: "greeting() returns 'x'.", passages: ['P2'], check: fn('lib/greet.js', 'greeting', ['x'], 'x') }], { allowed: ['lib/greet.js'] }), /greeting\(\).*has no check with those arguments/],
    ['zero arguments versus ONE empty array', FIRST, draft(FIRST, [
      { criterion: 'first([]) returns null.', passages: ['P2'], check: fn('lib/list.js', 'first', [], null) },
      { criterion: 'first([7, 8]) still returns 7.', passages: ['P3'], check: fn('lib/list.js', 'first', [[7, 8]], 7) }], { allowed: ['lib/list.js'] }), /CHK-1 changes the argument shape of the request's example first\(\[\]\)/],
    ['two strings versus ONE string array', JOINALL, draft(JOINALL, [
      { criterion: 'joinAll(["a", "b"]) returns "a,b".', passages: ['P2'], check: fn('lib/text.js', 'joinAll', ['a', 'b'], 'a,b') }], { allowed: ['lib/text.js'] }), /CHK-1 changes the argument shape of the request's example joinAll\(\["a", "b"\]\)/],
    ['nested arrays spread into two arguments', FLAT, draft(FLAT, [
      { criterion: 'flat([[1, 2], [3]]) returns [1, 2, 3].', passages: ['P2'], check: fn('lib/grid.js', 'flat', [[1, 2], [3]], [1, 2, 3]) }], { allowed: ['lib/grid.js'] }), /changes the argument shape/],
    ['correction C: a contradictory check for the SAME target and args fails even next to a correct one', FIRST, firstOk([
      { criterion: 'first([]) throws.', passages: ['P2'], check: throwsFn('lib/list.js', 'first', [[]]) }]), /CHK-3 contradicts the request's example first\(\[\]\) returns null/],
    ['required message ABSENT on a new export (KAN-106 S3 checklist, known regression)', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0])), /requires an error message including "whole must not be zero"/],
    ['required message WRONG on a new export', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0], 'whole must not be 0')), /requires an error message including "whole must not be zero"/],
    ['required message returned as a string instead of thrown', PCT, pct(fn('lib/math.js', 'percent', [1, 0], 'whole must not be zero')), /requires an error message including "whole must not be zero"/],
    ['correction A: the right message at UNRELATED args (whole is 1, not 0) cannot certify the condition', PCT, pct(throwsFn('lib/math.js', 'percent', [0, 1], 'whole must not be zero')), /requires an error message including "whole must not be zero".*When whole is 0/],
    ['correction A: an invented SUPERSTRING is not the requested fragment', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0], 'whole must not be zero!')), /exact/],
    ['correction A: wrong CASE: f(0) checks the wrong message while only f(-1) checks the requested text', F0, draft(F0, [
      { criterion: 'f(0) throws an error whose message includes "zero".', passages: ['P2'], check: throwsFn('lib/f.js', 'f', [0], 'negative') },
      { criterion: 'f(-1) throws (extra case).', passages: ['P2'], check: throwsFn('lib/f.js', 'f', [-1], 'zero') }], { allowed: ['lib/f.js'] }), /requires an error message including "zero" for f\(0\).*CHK-1/],
    ['correction A: invented superstring on an explicit call example', F0, draft(F0, [
      { criterion: 'f(0) throws an error whose message includes "zero".', passages: ['P2'], check: throwsFn('lib/f.js', 'f', [0], 'zero is not allowed') }], { allowed: ['lib/f.js'] }), /exact/],
    ['Q2: duplicate export names: the example cannot be tied to one module', 'lib/a.js and lib/b.js both export fmt. Make fmt(5) return "05".',
      draft('lib/a.js and lib/b.js both export fmt. Make fmt(5) return "05".', [
        { criterion: 'fmt(5) returns "05".', passages: ['P2'], check: fn('lib/a.js', 'fmt', [5], '05') }], { allowed: ['lib/a.js'] }), /fmt\(5\).*cannot be tied to one target/],
    ['decision 5: general rule dropped to context, only its example kept (S1 shape, known regression)',
      'In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".',
      draft('In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".', [
        { criterion: 'slugify("a  b") returns "a-b".', passages: ['P3'], check: fn('lib/slug.js', 'slugify', ['a  b'], 'a-b') }], { allowed: ['lib/slug.js'] }), /general rule .*each run of spaces into a single dash.* is not retained/],
  ];
  for (const [name, request, raw, want] of negatives) {
    test(`rejected: ${name}`, () => {
      const s = stateOf(request, raw);
      assert.equal(s.state, 'invalid');
      assert.match(s.errors.join('\n'), want);
    });
  }

  const positives = [
    ['KAN-104 faithful greeting draft', read104('request.txt').trim(), JSON.parse(read104('faithful-draft.json'))],
    ['Q1: the zero-argument example checked with zero arguments', GREET, draft(GREET, [{ criterion: "greeting() returns 'x'.", passages: ['P2'], check: fn('lib/greet.js', 'greeting', [], 'x') }], { allowed: ['lib/greet.js'] })],
    ['throw example checked by call_throws (error class shown as NOT checked, never claimed)', PORT, draft(PORT, [
      { criterion: 'parsePort("70000") throws.', passages: ['P2'], check: throwsFn('src/port.js', 'parsePort', ['70000']) },
      { criterion: 'parsePort("8080") still returns 8080.', passages: ['P3'], check: fn('src/port.js', 'parsePort', ['8080'], 8080) }], { allowed: ['src/port.js'] })],
    ['one empty-array argument kept as one argument', FIRST, firstOk()],
    ['correction C: a correct example check plus unrelated extra checks (even one resembling the flattened shape)', FIRST, firstOk([
      { criterion: 'first() with no argument throws.', passages: ['P2'], check: throwsFn('lib/list.js', 'first', []) },
      { criterion: 'first([1, 2, 3]) returns 1.', passages: ['P2'], check: fn('lib/list.js', 'first', [[1, 2, 3]], 1) }])],
    ['one string-array argument', JOINALL, draft(JOINALL, [{ criterion: 'joinAll(["a", "b"]) returns "a,b".', passages: ['P2'], check: fn('lib/text.js', 'joinAll', [['a', 'b']], 'a,b') }], { allowed: ['lib/text.js'] })],
    ['nested arrays as one argument', FLAT, draft(FLAT, [{ criterion: 'flat([[1, 2], [3]]) returns [1, 2, 3].', passages: ['P2'], check: fn('lib/grid.js', 'flat', [[[1, 2], [3]]], [1, 2, 3]) }], { allowed: ['lib/grid.js'] })],
    ['required message present, exact fragment, at the bound condition', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0], 'whole must not be zero'))],
    ['the exact message on the right case, plus an extra case', F0, draft(F0, [
      { criterion: 'f(0) throws an error whose message includes "zero".', passages: ['P2'], check: throwsFn('lib/f.js', 'f', [0], 'zero') },
      { criterion: 'f(-1) throws (extra case).', passages: ['P2'], check: throwsFn('lib/f.js', 'f', [-1], 'negative') }], { allowed: ['lib/f.js'] })],
    ['extra checks beyond the examples', TEMP, draft(TEMP, [
      { criterion: 'toF(100) returns 212.', passages: ['P2'], check: fn('lib/temp.js', 'toF', [100], 212) },
      { criterion: 'toF(0) still returns 32.', passages: ['P3'], check: fn('lib/temp.js', 'toF', [0], 32) },
      { criterion: 'toF(-40) returns -40.', passages: ['P2'], check: fn('lib/temp.js', 'toF', [-40], -40) }], { allowed: ['lib/temp.js'] })],
    ['the module named in the sentence disambiguates a duplicate name', 'In lib/a.js, make fmt(5) return "05".',
      draft('In lib/a.js, make fmt(5) return "05".', [{ criterion: 'fmt(5) returns "05".', passages: ['P2'], check: fn('lib/a.js', 'fmt', [5], '05') }], { allowed: ['lib/a.js'] })],
    ['a legitimate request with no literal examples (U1 sentence shape)', 'In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.',
      draft('In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.', [
        { criterion: 'UserRepo.find("nope") returns null for an unknown id.', passages: ['P2'], check: method('lib/users.js', 'find', [[['nope'], null]]) }], { allowed: ['lib/users.js'] })],
    ['a legitimate request with no literal calls at all', 'Add a clamp function to src/utils.js.',
      draft('Add a clamp function to src/utils.js.', [{ criterion: 'clamp is exported from src/utils.js.', passages: ['P1'] }], { allowed: ['src/utils.js'] })],
    ['general rule retained with its sampled example (S1 shape)', 'In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".',
      draft('In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".', [
        { criterion: 'slugify turns each run of spaces into a single dash: slugify("a  b") returns "a-b" (sampled by this example).', passages: ['P2', 'P3'], check: fn('lib/slug.js', 'slugify', ['a  b'], 'a-b') }], { allowed: ['lib/slug.js'] })],
  ];
  for (const [name, request, raw] of positives) {
    test(`accepted: ${name}`, () => {
      assert.equal(stateOf(request, raw).state, 'finalized', errorsOf(request, raw));
      assert.deepEqual(RX().exampleErrors(contract(request, raw)), []);
    });
  }
  test('decision 5: a rule quoted clause by clause (legacy drafts) is retained when every overlapping requirement is cited; not when one clause is context', () => {
    const R = 'Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]';   // as the QB-31 demo request (no final period)
    const base = { goal: R, required_behavior: [R], constraints: [], constraint_policy: [], verification_plan: ['Run the checks.'], relevant_context: ['src/utils.js'],
      ambiguity_flags: [], clarifying_question: null, proposed_defaults: [], scope: { allowed_changes: ['src/utils.js'], protected_paths: [] },
      checks: [fn('src/utils.js', 'clamp', [5, 0, 3], 3)].map((k, i) => ({ id: `CHK-${i + 1}`, ac_id: 'AC-2', ...k })),
      acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp is exported from src/utils.js.', requirement_ids: ['R-1'] }, { id: 'AC-2', criterion: 'clamp(5, 0, 3) returns 3 (n bounded to [min, max]).', requirement_ids: ['R-2'] }] };
    const kept = { ...base, requirements: [{ id: 'R-1', quote: 'Add a clamp(n, min, max) function to src/utils.js' }, { id: 'R-2', quote: 'bounds n to [min, max]' }] };
    assert.equal(stateOf(R, kept).state, 'finalized', errorsOf(R, kept));
    const dropped = { ...base, requirements: [{ id: 'R-1', quote: 'Add a clamp(n, min, max) function to src/utils.js' }, { id: 'R-2', quote: 'bounds n to [min, max]', disposition: 'context', reason: 'location only' }],
      acceptance_criteria: [base.acceptance_criteria[0], { ...base.acceptance_criteria[1], requirement_ids: ['R-1'] }] };
    assert.match(errorsOf(R, dropped), /general rule P1 .* is not retained/);
  });
  test('decision 3 / correction D: the error class of a throw example is shown as NOT checked (message_includes checks text only)', () => {
    const [, request, raw] = positives[2];
    const row = RX().exampleMapping(contract(request, raw)).find((x) => x.outcome === 'throws');
    assert.deepEqual([row.check_id, row.error_class, row.error_class_status], ['CHK-1', 'RangeError', 'not_checked']);
  });
  test('correction A: a "message is" (equality) requirement is shown as equality NOT checked; only inclusion runs', () => {
    const R = 'In lib/f.js, make f(0) throw an error whose message is "zero".';
    const raw = draft(R, [{ criterion: 'f(0) throws an error whose message is "zero".', passages: ['P2'], check: throwsFn('lib/f.js', 'f', [0], 'zero') }], { allowed: ['lib/f.js'] });
    assert.equal(stateOf(R, raw).state, 'finalized', errorsOf(R, raw));
    const row = RX().exampleMapping(contract(R, raw)).find((x) => x.outcome === 'throws');
    assert.deepEqual([row.check_id, row.message_status], ['CHK-1', 'equality_not_checked']);
  });
  test('conditional message whose condition QB cannot bind is refused (no signature names the parameter)', () => {
    const R = 'In lib/q.js, make take(1) return 1. When the queue is empty it must throw an error whose message includes "empty".';
    const raw = draft(R, [
      { criterion: 'take(1) returns 1.', passages: ['P2'], check: fn('lib/q.js', 'take', [1], 1) },
      { criterion: 'take(0) throws "empty".', passages: ['P3'], check: throwsFn('lib/q.js', 'take', [0], 'empty') }], { allowed: ['lib/q.js'] });
    assert.match(errorsOf(R, raw), /requires an error message including "empty".*condition .*cannot be bound/);
  });

  describe('decision 4 / correction D: underspecified behaviour (U2, known regression)', () => {
    const U2 = 'In lib/round.js, make roundTo() handle negative numbers properly.';
    const invented = (defaults, dText) => draft(U2, [
      { criterion: 'roundTo(-1.234, 2) returns -1.23.', passages: ['P2'], defaults, check: fn('lib/round.js', 'roundTo', [-1.234, 2], -1.23) }],
    { allowed: ['lib/round.js'], defaults: dText ? [{ id: 'D-1', text: dText, reason: 'the request states no expected value' }] : [] });
    test('rejected: invented expected values with no stated behaviour', () => assert.match(errorsOf(U2, invented([])), /P2 .*states no expected behaviour/));
    test('rejected: a meaningless D-n citation does not bless the invented value', () => assert.match(errorsOf(U2, invented(['D-1'], 'a sensible default for negatives')), /D-1 .*does not state the behaviour/));
    test('accepted only as a SEPARATE proposed default D-n that states exactly the behaviour its check introduces (shown for explicit approval)', () => {
      const raw = invented(['D-1'], 'roundTo(-1.234, 2) returns -1.23 (QB-proposed: negative numbers keep their sign)');
      assert.equal(stateOf(U2, raw).state, 'finalized', errorsOf(U2, raw));
      const rows = RX().exampleMapping(contract(U2, raw));
      assert.ok(rows.some((x) => x.source === 'proposed_default' && x.id === 'D-1' && x.check_id === 'CHK-1'));
      const { formatOracle } = require('../../intent/oracle-view');
      assert.match(formatOracle(contract(U2, raw)), /Proposed defaults[\s\S]*D-1 roundTo\(-1\.234, 2\) returns -1\.23/);
    });
    test('explicitly specified rounding (contrast): a stated example, checked, is valid and not underspecified', () => {
      const R = 'In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.';
      const raw = draft(R, [{ criterion: 'roundTo rounds negative halves away from zero: roundTo(-2.5, 0) returns -3.', passages: ['P2', 'P3'], check: fn('lib/round.js', 'roundTo', [-2.5, 0], -3) }], { allowed: ['lib/round.js'] });
      assert.equal(stateOf(R, raw).state, 'finalized', errorsOf(R, raw));
      assert.equal(RX().extractExamples(R).underspecified.length, 0);
    });
  });
});

// ── correction B: default-class methods from QB's REAL grounding only ─────────
describe('KAN-107 default-class methods from QB-computed grounding (correction B)', () => {
  const FMT = 'In lib/formatter.js, make Formatter.join([]) return "". Keep Formatter.join(["a", "b"]) returning "a,b".';
  const fmtDraft = (steps1, steps2) => draft(FMT, [
    { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', steps1) },
    { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: method('lib/formatter.js', 'join', steps2) }], { allowed: ['lib/formatter.js'] });
  const RIGHT = fmtDraft([[[[]], '']], [[[['a', 'b']], 'a,b']]);
  const G = () => grounded(FMT, { 'lib/formatter.js': SRC.formatterBase });

  test('accepted: correct call_sequence checks on a fresh instance, with REAL grounding (static eligibility, not a proof that construction succeeds)', () => {
    assert.equal(stateOf(FMT, RIGHT, G()).state, 'finalized', errorsOf(FMT, RIGHT, G()));
    assert.deepEqual(runChecks(contract(FMT, RIGHT).checks, { 'lib/formatter.js': SRC.formatter }), { 'CHK-1': 'pass', 'CHK-2': 'pass' });
  });
  test('rejected: the KAN-106 S2 flattened checks (args [] and ["a", "b"]), with REAL grounding (known regression)', () => {
    const raw = fmtDraft([[[], '']], [[['a', 'b'], 'a,b']]);
    assert.match(errorsOf(FMT, raw, G()), /changes the argument shape of the request's example Formatter\.join\(\[\]\)[\s\S]*changes the argument shape of the request's example Formatter\.join\(\["a", "b"\]\)/);
  });
  test('rejected: missing grounding: a receiver QB has not grounded is never resolved from the checks or allowed files', () => {
    assert.match(errorsOf(FMT, RIGHT), /Formatter\.join\(\[\]\).*cannot be tied to one target.*grounding/);
  });
  test('rejected: a receiver that is not the grounded default class', () => {
    const R = 'In lib/formatter.js, make Parser.join([]) return "".';
    const raw = draft(R, [{ criterion: 'Parser.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[[]], '']]) }], { allowed: ['lib/formatter.js'] });
    assert.match(errorsOf(R, raw, grounded(R, { 'lib/formatter.js': SRC.formatterBase })), /Parser\.join\(\[\]\).*cannot be tied to one target/);
  });
  test('rejected: a constructor the bounded static reading cannot clear (10758: stored dependency dereferenced)', () => {
    const R = 'In lib/users.js, make UserRepo.find("x") return null.';
    const raw = draft(R, [{ criterion: 'UserRepo.find("x") returns null.', passages: ['P2'], check: method('lib/users.js', 'find', [[['x'], null]]) }], { allowed: ['lib/users.js'] });
    assert.match(errorsOf(R, raw, grounded(R, { 'lib/users.js': SRC.users })), /UserRepo\.find\("x"\).*cannot be tied to one target.*constructor/);
  });
  test('rejected: ambiguous grounding: two request-named modules both define the method', () => {
    const R = 'In lib/a.js and lib/b.js, make join(["a"]) return "a".';
    const raw = draft(R, [{ criterion: 'join(["a"]) returns "a".', passages: ['P2'], check: method('lib/a.js', 'join', [[[['a']], 'a']]) }], { allowed: ['lib/a.js'] });
    assert.match(errorsOf(R, raw, grounded(R, { 'lib/a.js': SRC.formatterBase, 'lib/b.js': SRC.formatterBase })), /join\(\["a"\]\).*cannot be tied to one target/);
  });
  test('rejected: not a fresh instance: a setup/mutation step before the example call (sequences unsupported in v1)', () => {
    const raw = draft(FMT, [
      { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[[]], '']]) },
      { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: { adapter: 'call_sequence', params: { module: 'lib/formatter.js', export: 'default', instances: { s: { construct: 'new', args: [] } },
        steps: [{ on: 's', method: 'setSeparator', args: [','] }, { on: 's', method: 'join', args: [['a', 'b']], expect: 'a,b' }] } } }], { allowed: ['lib/formatter.js'] });
    assert.match(errorsOf(FMT, raw, G()), /Formatter\.join\(\["a", "b"\]\).*has no executable check/);
  });
});

// ── integration (decisions 1, 7): legacy correction, CLI --contract-file, approval view and hash, protection ──
describe('KAN-107 integration through the real producers', () => {
  const { compileIntent } = require('../../intent/session');
  const REQUEST = read104('request.txt').trim();
  async function compileWith(replies, request = REQUEST) {
    let i = 0;
    const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
    try { const s = await compileIntent(request); return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages) }; } finally { m.restore(); }
  }
  test('legacy path: the faithful greeting draft finalizes with ONE model call', async () => {
    const { s, calls } = await compileWith([read104('faithful-draft.json')]);
    assert.deepEqual([s.state, calls], ['finalized', 1]);
  });
  test('legacy path: a contradictory draft gets the ONE existing correction (which sees the example error); a contradictory correction stops invalid with no extra call', async () => {
    const C = read104('contradictory-check-draft.json');
    const { s, calls, prompts } = await compileWith([C, C, C]);
    assert.equal(calls, 2, 'one draft plus the one existing correction; no new retry loop');
    assert.equal(s.state, 'invalid');
    assert.match(JSON.stringify(prompts[1]), /has no check with those arguments/);
    assert.match(s.errors.join('\n'), /greeting\("Arshad"\)/);
  });
  test('legacy path: the correction that fixes the example finalizes (two calls)', async () => {
    const { s, calls } = await compileWith([read104('contradictory-check-draft.json'), read104('faithful-draft.json')]);
    assert.deepEqual([s.state, calls], ['finalized', 2]);
  });
  test('CLI --contract-file: a contradictory supplied contract is BLOCKED as supplied and the file is never rewritten', () => {
    const { makeRepo } = require('../helpers/tmprepo');
    const repo = makeRepo({ 'src/greeting.js': 'export function greeting() {\n  return "Hello from Node Project JS!";\n}\n', 'package.json': '{"name":"g","type":"module"}' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-cli-'));
    try {
      const file = path.join(tmp, 'c.json');
      fs.writeFileSync(file, read104('contradictory-check-draft.json'));
      const before = fs.readFileSync(file);
      const r = spawnSync(process.execPath, ['--require', path.join(__dirname, '..', 'helpers', 'preload-ollama.js'), path.join(ROOT, 'qb.js'), REQUEST,
        '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--contract-file', file],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_OLLAMA_URL: 'http://127.0.0.1:9', QB_TEST_FETCH_LOG: path.join(tmp, 'fetch.log') } });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, /contract file .* is not valid \(it is never rewritten automatically\)/);
      assert.match(r.stdout, /greeting\("Arshad"\).*has no check with those arguments/);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.existsSync(path.join(tmp, 'fetch.log')), false, 'no model call');
      const run = fs.readdirSync(path.join(tmp, 'runs'))[0];
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'runs', run, 'manifest.json'), 'utf8')).outcome, 'BLOCKED');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); repo.cleanup(); }
  });
  test('loadContractFile: the supplied checks are not corrected to fit', () => {
    const { loadContractFile } = require('../../intent/contract-file');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-cf-'));
    try {
      const file = path.join(dir, 'c.json');
      fs.writeFileSync(file, read104('contradictory-check-draft.json'));
      const { contract: c } = loadContractFile(file, REQUEST);
      assert.equal(contractState(c).state, 'invalid');
      assert.deepEqual(c.checks[0].params.args, ['test']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('approval view: each request example as excerpt -> target(args) outcome -> check id', () => {
    const { formatOracle } = require('../../intent/oracle-view');
    const view = formatOracle(contractFromObject(JSON.parse(read104('faithful-draft.json')), REQUEST));
    assert.match(view, /Request examples/);
    assert.match(view, /greeting\("Arshad"\) returns "Hello, Arshad!".*->.*src\/greeting\.js greeting\(\["Arshad"\]\) returns "Hello, Arshad!".*->.*CHK-1/);
  });
  test('approval hash: flattening an approved example check voids the approval AND the contract is rejected', () => {
    const c = approve(contractFromObject(JSON.parse(read104('faithful-draft.json')), REQUEST), { via: 'test' });
    assert.equal(approvalState(c).approved, true);
    const changed = JSON.parse(JSON.stringify(c));
    changed.checks[0].params.args = [['Arshad']];
    assert.equal(approvalState(changed).reason, 'changed_after_approval');
    assert.equal(contractState(changed).state, 'invalid');
  });
  test('protection preserved: the KAN-105 conflict still rejects a draft whose examples are correct but whose scope protects the requested file', () => {
    const raw = JSON.parse(read104('faithful-draft.json'));
    raw.scope.protected_paths = ['src/greeting.js'];
    assert.match(errorsOf(REQUEST, raw), /protected_paths/);
  });
});

// ── the staged compiler (decisions 2, 3, 4, 7) with a FAKE model ──────────────
describe('KAN-107 staged compiler with a faked model (KAN-106 known regressions, not fresh validation)', () => {
  const { l1Budget } = require('../../lib/budget');
  /** The real staged producer; `reply(calls, rid, user)` is the FAKE model's facts for one requirement. */
  async function produce(request, files, reply) {
    const repo = makeDir(files, 'kan107-staged-');
    const byRid = {};
    const m = mockFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      const it = body.format.properties.cases.items.properties;
      const user = body.messages.filter((x) => x.role === 'user').map((x) => x.content).join('\n');
      const rid = it.requirement.enum[0];
      byRid[rid] = (byRid[rid] || 0) + 1;
      return { ...ollamaReply(JSON.stringify(reply(it.call.enum, rid, user))), model: 'fake-model' };
    });
    try { return { s: await require('../../intent/session').compileIntent(request, { repoPath: repo.dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) }), calls: m.calls.length, byRid }; }
    finally { m.restore(); repo.cleanup(); }
  }
  const one = (calls, rid, args, outcome, expected, frag = null, name = null) => ({ cases: [{ requirement: rid, call: name ? calls.find((c) => c.startsWith(name)) : calls[0], args, outcome, expected, error_fragment: frag }] });
  const FIRST = 'In lib/list.js, make first([]) return null.';
  const S2 = 'In lib/formatter.js, make Formatter.join() return an empty string for an empty array instead of undefined. Keep join(["a", "b"]) returning "a,b".';

  test('one empty-array argument: the fake model states args [[]]; the checklist keeps ONE argument and it runs', async () => {
    const { s } = await produce(FIRST, { 'lib/list.js': SRC.list }, (calls, rid) => one(calls, rid, [[]], 'returns', null));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.checks[0].params.args, [[]]);
    assert.deepEqual(runChecks(s.contract.checks, { 'lib/list.js': SRC.list }), { 'CHK-1': 'pass' });
  });
  test('zero arguments for the request example first([]) is refused after assembly (changed shape); no extra repair call', async () => {
    const { s, calls } = await produce(FIRST, { 'lib/list.js': SRC.list }, (calls, rid) => one(calls, rid, [], 'returns', null));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /changes the argument shape/);
    assert.equal(calls, 1, 'one fact call; the post-assembly refusal starts no new call');
  });
  test('an object argument is refused by the schema after the one fact repair, never coerced (Q3)', async () => {
    const { s, byRid } = await produce(FIRST, { 'lib/list.js': SRC.list }, (calls, rid) => one(calls, rid, [{ a: 1 }], 'returns', null));
    assert.equal(s.state, 'invalid');
    assert.deepEqual(byRid, { 'R-2': 2 }, 'one fact call plus its ONE repair');
  });
  test('an object-literal example tied to a target is refused BEFORE generation (no call)', async () => {
    const { s, calls } = await produce('In lib/list.js, make first({ a: 1 }) return 1.', { 'lib/list.js': SRC.list }, (calls, rid) => one(calls, rid, [1], 'returns', 1));
    assert.equal(calls, 0);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /object/);
  });
  test('S2 (known regression): ONE array argument on a default-class method is expressible, checked and runs', async () => {
    const { s } = await produce(S2, { 'lib/formatter.js': SRC.formatterBase }, (calls, rid) => (rid === 'R-2' ? one(calls, rid, [[]], 'returns', '') : one(calls, rid, [['a', 'b']], 'returns', 'a,b')));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.checks.map((k) => k.params.steps[0].args), [[[]], [['a', 'b']]]);
    assert.deepEqual(runChecks(s.contract.checks, { 'lib/formatter.js': SRC.formatter }), { 'CHK-1': 'pass', 'CHK-2': 'pass' });
  });
  test('S2 (known regression): the recorded flattened facts (args [] and ["a", "b"]) are refused', async () => {
    const { s, calls } = await produce(S2, { 'lib/formatter.js': SRC.formatterBase }, (calls, rid) => (rid === 'R-2' ? one(calls, rid, [], 'returns', '') : one(calls, rid, ['a', 'b'], 'returns', 'a,b')));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /changes the argument shape of the request's example join\(\["a", "b"\]\)/);
    assert.equal(calls, 2, 'one fact call per requirement; no new retry loop');
  });
  const S3 = 'In lib/math.js, create and export a function percent(part, whole) that returns part / whole * 100 rounded to the nearest whole number, for example percent(1, 3) returns 33 and percent(2, 3) returns 67. When whole is 0 it must throw an error whose message includes "whole must not be zero". Keep add(2, 3) returning 5.';
  const fragNo = (user) => { const m = [...user.matchAll(/^(\d+): (".*")$/gm)].find((x) => JSON.parse(x[2]) === 'whole must not be zero'); return m ? Number(m[1]) : null; };
  const s3 = (zeroArgs) => (calls, rid, user) => {
    const pct = calls.find((c) => c.startsWith('percent'));
    if (rid === 'R-5') return one(calls, rid, [2, 3], 'returns', 5, null, 'add');
    if (rid === 'R-4') return one(calls, rid, zeroArgs, 'throws', null, fragNo(user), 'percent');
    return { cases: [{ requirement: rid, call: pct, args: [1, 3], outcome: 'returns', expected: 33, error_fragment: null }, { requirement: rid, call: pct, args: [2, 3], outcome: 'returns', expected: 67, error_fragment: null }] };
  };
  test('S3 (known regression): the request-quoted message is offered (exact text) for the NEW export and lands in the check at the bound condition', async () => {
    const { s } = await produce(S3, { 'lib/math.js': SRC.math }, s3([1, 0]));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    const k = s.contract.checks.find((x) => x.adapter === 'call_throws');
    assert.deepEqual([k.params.args, k.params.message_includes], [[1, 0], 'whole must not be zero']);
    assert.deepEqual(runChecks(s.contract.checks, { 'lib/math.js': SRC.mathPercent })[k.id], 'pass');
  });
  test('S3: the right message at unrelated args (whole is 3) is refused after assembly', async () => {
    const { s } = await produce(S3, { 'lib/math.js': SRC.math }, s3([0, 3]));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /requires an error message including "whole must not be zero"/);
  });
  test('U2 (known regression): an underspecified change stops BEFORE any model call; nothing invented', async () => {
    const U2 = 'In lib/round.js, make roundTo() handle negative numbers properly.';
    const { s, calls } = await produce(U2, { 'lib/round.js': SRC.round }, (calls, rid) => one(calls, rid, [-1.234, 2], 'returns', -1.23));
    assert.equal(calls, 0);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /states no expected behaviour/);
  });
  test('explicit rounding: the fake model states the request example exactly: finalized', async () => {
    const R = 'In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.';
    const { s } = await produce(R, { 'lib/round.js': SRC.round }, (calls, rid) => one(calls, rid, [-2.5, 0], 'returns', -3));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.checks[0].params.args, [-2.5, 0]);
  });
  test('explicit rounding: the fake model drops an argument of the stated example roundTo(-2.5, 0): refused', async () => {
    const R = 'In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.';
    const { s } = await produce(R, { 'lib/round.js': SRC.round }, (calls, rid) => one(calls, rid, [-2.5], 'returns', -3));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /roundTo\(-2\.5, 0\).*has no check with those arguments/);
  });
  test('protection preserved (S4 shape): "Do not change lib/defaults.js." stays a protected path while the examples are enforced', async () => {
    const S4 = 'In lib/env.js, make parseBool() also treat "1" and "yes" as true, so parseBool("yes") returns true and parseBool("1") returns true. Keep parseBool("true") returning true. Do not change lib/defaults.js.';
    const facts = { 'R-2': [['yes', true], ['1', true]], 'R-3': [['yes', true], ['1', true]], 'R-4': [['true', true]] };
    const { s } = await produce(S4, { 'lib/env.js': SRC.envBase, 'lib/defaults.js': SRC.defaults }, (calls, rid) => ({ cases: (facts[rid] || [['yes', true], ['1', true]]).map(([a, e]) => ({ requirement: rid, call: calls[0], args: [a], outcome: 'returns', expected: e, error_fragment: null })) }));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.scope.protected_paths, ['lib/defaults.js']);
    assert.deepEqual(RX().exampleErrors(s.contract), []);
  });
});
