/**
 * KAN-107 (senior 10766): request-to-check consistency. RED regression tests, written before any
 * implementation and before the design is reviewed. OFFLINE: no model (the model is faked), nothing live.
 *
 * Every test that needs the not-yet-built rule is a node:test TODO, so `npm test` stays green on the
 * design branch. Run them as real tests to see them fail:
 *     KAN107_RED=1 node --test test/unit/kan107-consistency.test.js
 * Positive controls that already pass today are ordinary tests: the rule must not break them.
 *
 * Design: docs/design/kan107-request-check-consistency.md. Module under design: intent/request-examples.js
 * (parseLiteral, extractExamples, exampleErrors, exampleMapping), wired into intent/contract-state.js,
 * intent/staged.js (bounded literal args, request-sourced message fragments, underspecified stop) and the
 * approval view (intent/oracle-view.js).
 *
 * The KAN-106 eight requests (S1-S6, U1, U2) appear here as KNOWN DEVELOPMENT CASES (their outcomes have
 * been seen). They are regression fixtures, never a fresh validation set.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { contractFromObject } = require('../../intent/compiler');
const { contractState } = require('../../intent/contract-state');
const { draft, fn, throwsFn, method } = require('../fixtures/kan107/build');

const RED = { todo: 'KAN-107: not implemented; design under senior review (docs/design/kan107-request-check-consistency.md)' };
const t = (name, body) => test(name, process.env.KAN107_RED ? {} : RED, body);
const RX = () => require('../../intent/request-examples');
const stateOf = (request, raw) => contractState(contractFromObject(raw, request));
const errorsOf = (request, raw) => { const s = stateOf(request, raw); return s.state === 'invalid' ? s.errors.join('\n') : ''; };
const K104 = path.join(__dirname, '..', 'fixtures', 'kan104');
const read104 = (f) => fs.readFileSync(path.join(K104, f), 'utf8');

// ── literal parsing: no eval, nesting and types preserved, bounded ──────────
describe('KAN-107 literals (decision 2)', () => {
  t('JSON-like literals parse without eval; nesting and types are preserved', () => {
    const { parseLiteral } = RX();
    assert.deepEqual(parseLiteral('[]').value, []);
    assert.deepEqual(parseLiteral('["a", "b"]').value, ['a', 'b']);
    assert.deepEqual(parseLiteral("['a', 'b']").value, ['a', 'b']);
    assert.deepEqual(parseLiteral('[[1, 2], [3]]').value, [[1, 2], [3]]);
    assert.deepEqual(parseLiteral('-2.5').value, -2.5);
    assert.deepEqual(parseLiteral('"1"').value, '1');
    assert.notDeepEqual(parseLiteral('"1"').value, parseLiteral('1').value, 'a string is not a number');
    assert.deepEqual(parseLiteral('null').value, null);
  });
  t('unsupported literals are refused with a reason, never coerced or flattened', () => {
    const { parseLiteral } = RX();
    for (const [text, why] of [['[[[[1]]]]', /depth/], ['{ a: 1 }', /object/], ['`a${b}`', /template/], ['x', /identifier|variable/], ['1 + 2', /expression/], ['undefined', /undefined|not JSON/],
      [`[${Array(17).fill(0).join(', ')}]`, /items|size/]]) {
      const r = parseLiteral(text);
      assert.equal(r.ok, false, text);
      assert.match(r.reason, why, text);
    }
  });
});

// ── extraction ─────────────────────────────────────────────────────────────
describe('KAN-107 extraction from the request text only', () => {
  t('call examples with returns / returning / throws; the first value after the verb; keep examples', () => {
    const { examples } = RX().extractExamples('In lib/temp.js, make toF(100) return 212 instead of 211. Keep toF(0) returning 32.');
    assert.deepEqual(examples.map((e) => [e.name, e.args, e.outcome, e.expected, e.kept]), [['toF', [100], 'returns', 212, false], ['toF', [0], 'returns', 32, true]]);
    assert.ok(examples.every((e) => typeof e.excerpt === 'string' && Array.isArray(e.span) && e.passage_id));
  });
  t('`make name()` is a NAME MENTION, not a zero-argument example; `name() with no argument returning X` is one', () => {
    const { examples } = RX().extractExamples(read104('request.txt').trim());
    assert.deepEqual(examples.map((e) => [e.name, e.args, e.expected]), [['greeting', ['Arshad'], 'Hello, Arshad!'], ['greeting', [], 'Hello from Node Project JS!']]);
  });
  t('conditional prose ("for an empty array", "for an unknown id") is not an example: recorded unsupported, no error', () => {
    const r = RX().extractExamples('In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.');
    assert.deepEqual(r.examples, []);
  });
  t('variables, template strings and expressions as arguments are unsupported (recorded, never guessed)', () => {
    const r = RX().extractExamples('In lib/math.js, make percent(part, whole) return part / whole * 100.');
    assert.deepEqual(r.examples, []);
    assert.ok(r.unsupported.some((u) => /percent/.test(u.excerpt)));
  });
  t('a request-sourced error message is bound to its span and to one target, even for a new export (S3 shape)', () => {
    const req = 'In lib/math.js, create and export a function percent(part, whole) that returns part / whole * 100 rounded to the nearest whole number, for example percent(1, 3) returns 33. When whole is 0 it must throw an error whose message includes "whole must not be zero".';
    const r = RX().extractExamples(req);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].fragment, 'whole must not be zero');
    assert.equal(r.messages[0].name, 'percent');
    assert.equal(req.slice(...r.messages[0].span).includes('whole must not be zero'), true);
  });
  t('an error CLASS is recorded as such and never treated as message text', () => {
    const { examples } = RX().extractExamples('In src/port.js, make parsePort("70000") throw a RangeError.');
    assert.equal(examples[0].outcome, 'throws');
    assert.equal(examples[0].error_class, 'RangeError');
    assert.equal(examples[0].message_includes ?? null, null);
  });
  t('general rules are kept as reviewable requirements, separate from the example (S1 / S5 shapes)', () => {
    const r = RX().extractExamples('In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".');
    assert.deepEqual(r.rules.map((x) => x.passage_id), ['P2']);
    assert.equal(r.examples.length, 1);
  });
});

// ── the rule through contractState (legacy drafts, corrections, staged output and --contract-file all go through it) ──
describe('KAN-107 consistency errors (decisions 1, 2, 3, 6)', () => {
  const TEMP = 'In lib/temp.js, make toF(100) return 212. Keep toF(0) returning 32.';
  const PORT = 'In src/port.js, make parsePort("70000") throw a RangeError. Keep parsePort("8080") returning 8080.';
  const FIRST = 'In lib/list.js, make first([]) return null. Keep first([7, 8]) returning 7.';
  const JOINALL = 'In lib/text.js, make joinAll(["a", "b"]) return "a,b".';
  const FLAT = 'In lib/grid.js, make flat([[1, 2], [3]]) return [1, 2, 3].';
  const FMT = 'In lib/formatter.js, make Formatter.join([]) return "". Keep Formatter.join(["a", "b"]) returning "a,b".';
  const PCT = 'In lib/math.js, create and export a function percent(part, whole) that returns part / whole * 100 rounded to the nearest whole number, for example percent(1, 3) returns 33. When whole is 0 it must throw an error whose message includes "whole must not be zero".';
  const pct = (zeroCheck) => draft(PCT, [
    { criterion: 'percent(1, 3) returns 33 (part / whole * 100 rounded to the nearest whole number).', passages: ['P2', 'P3'], check: fn('lib/math.js', 'percent', [1, 3], 33) },
    { criterion: 'percent(1, 0) throws an error whose message includes "whole must not be zero".', passages: ['P4'], check: zeroCheck },
  ], { allowed: ['lib/math.js'] });

  const cases = [
    // [name, request, raw draft, expected error (null = valid)]
    ['KAN-104 historical greeting mismatch: greeting("test") expects "Hello, Arshad!"', read104('request.txt').trim(), JSON.parse(read104('contradictory-check-draft.json')), /greeting\("Arshad"\).*has no check with those arguments.*CHK-1/],
    ['return "Error" versus throw', PORT, draft(PORT, [
      { criterion: 'parsePort("70000") throws a RangeError.', passages: ['P2'], check: fn('src/port.js', 'parsePort', ['70000'], 'Error') },
      { criterion: 'parsePort("8080") still returns 8080.', passages: ['P3'], check: fn('src/port.js', 'parsePort', ['8080'], 8080) }], { allowed: ['src/port.js'] }), /CHK-1 contradicts the request's example parsePort\("70000"\) throws/],
    ['missing example: no check for toF(100)', TEMP, draft(TEMP, [
      { criterion: 'toF(100) returns 212.', passages: ['P2'] },
      { criterion: 'toF(0) still returns 32.', passages: ['P3'], check: fn('lib/temp.js', 'toF', [0], 32) }], { allowed: ['lib/temp.js'] }), /toF\(100\).*has no executable check/],
    ['zero arguments versus ONE empty array', FIRST, draft(FIRST, [
      { criterion: 'first([]) returns null.', passages: ['P2'], check: fn('lib/list.js', 'first', [], null) },
      { criterion: 'first([7, 8]) still returns 7.', passages: ['P3'], check: fn('lib/list.js', 'first', [[7, 8]], 7) }], { allowed: ['lib/list.js'] }), /CHK-1 changes the argument shape of the request's example first\(\[\]\)/],
    ['two strings versus ONE string array', JOINALL, draft(JOINALL, [
      { criterion: 'joinAll(["a", "b"]) returns "a,b".', passages: ['P2'], check: fn('lib/text.js', 'joinAll', ['a', 'b'], 'a,b') }], { allowed: ['lib/text.js'] }), /CHK-1 changes the argument shape of the request's example joinAll\(\["a", "b"\]\)/],
    ['nested arrays spread into two arguments', FLAT, draft(FLAT, [
      { criterion: 'flat([[1, 2], [3]]) returns [1, 2, 3].', passages: ['P2'], check: fn('lib/grid.js', 'flat', [[1, 2], [3]], [1, 2, 3]) }], { allowed: ['lib/grid.js'] }), /changes the argument shape/],
    ['default-class method with flattened array arguments (KAN-106 S2 checks, known development case)', FMT, draft(FMT, [
      { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[], '']]) },
      { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: method('lib/formatter.js', 'join', [[['a', 'b'], 'a,b']]) }], { allowed: ['lib/formatter.js'] }), /changes the argument shape of the request's example Formatter\.join\(\[\]\)[\s\S]*changes the argument shape of the request's example Formatter\.join\(\["a", "b"\]\)/],
    ['required message ABSENT on a new export (KAN-106 S3 checklist, known development case)', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0])), /requires an error message including "whole must not be zero"/],
    ['required message WRONG on a new export', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0], 'whole must not be 0')), /requires an error message including "whole must not be zero"/],
    ['required message returned as a string instead of thrown', PCT, pct(fn('lib/math.js', 'percent', [1, 0], 'whole must not be zero')), /requires an error message including "whole must not be zero"/],
    ['duplicate export names: the example cannot be tied to one module', 'lib/a.js and lib/b.js both export fmt. Make fmt(5) return "05".',
      draft('lib/a.js and lib/b.js both export fmt. Make fmt(5) return "05".', [
        { criterion: 'fmt(5) returns "05".', passages: ['P2'], check: fn('lib/a.js', 'fmt', [5], '05') }], { allowed: ['lib/a.js'] }), /fmt\(5\).*cannot be tied to one target/],
    ['general rule dropped to context, only its example kept (S1 shape, known development case)',
      'In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".',
      draft('In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".', [
        { criterion: 'slugify("a  b") returns "a-b".', passages: ['P3'], check: fn('lib/slug.js', 'slugify', ['a  b'], 'a-b') }], { allowed: ['lib/slug.js'] }), /general rule .*each run of spaces into a single dash.* is not retained/],
  ];
  for (const [name, request, raw] of cases) {
    test(`today's validators accept it (the gap): ${name}`, () => assert.equal(stateOf(request, raw).state, 'finalized'));
  }
  for (const [name, request, raw, want] of cases) t(`L1 error: ${name}`, () => assert.match(errorsOf(request, raw), want));

  const positives = [
    ['KAN-104 faithful greeting draft', read104('request.txt').trim(), JSON.parse(read104('faithful-draft.json'))],
    ['throw example checked by call_throws (error class recorded as NOT checked, never claimed)', PORT, draft(PORT, [
      { criterion: 'parsePort("70000") throws.', passages: ['P2'], check: throwsFn('src/port.js', 'parsePort', ['70000']) },
      { criterion: 'parsePort("8080") still returns 8080.', passages: ['P3'], check: fn('src/port.js', 'parsePort', ['8080'], 8080) }], { allowed: ['src/port.js'] })],
    ['one empty-array argument kept as one argument', FIRST, draft(FIRST, [
      { criterion: 'first([]) returns null.', passages: ['P2'], check: fn('lib/list.js', 'first', [[]], null) },
      { criterion: 'first([7, 8]) still returns 7.', passages: ['P3'], check: fn('lib/list.js', 'first', [[7, 8]], 7) }], { allowed: ['lib/list.js'] })],
    ['one string-array argument', JOINALL, draft(JOINALL, [{ criterion: 'joinAll(["a", "b"]) returns "a,b".', passages: ['P2'], check: fn('lib/text.js', 'joinAll', [['a', 'b']], 'a,b') }], { allowed: ['lib/text.js'] })],
    ['nested arrays as one argument', FLAT, draft(FLAT, [{ criterion: 'flat([[1, 2], [3]]) returns [1, 2, 3].', passages: ['P2'], check: fn('lib/grid.js', 'flat', [[[1, 2], [3]]], [1, 2, 3]) }], { allowed: ['lib/grid.js'] })],
    ['correct default-class method checks (call_sequence, construct new, fresh instance)', FMT, draft(FMT, [
      { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[[]], '']]) },
      { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: method('lib/formatter.js', 'join', [[[['a', 'b']], 'a,b']]) }], { allowed: ['lib/formatter.js'] })],
    ['required message present on a new export', PCT, pct(throwsFn('lib/math.js', 'percent', [1, 0], 'whole must not be zero'))],
    ['extra checks beyond the examples', TEMP, draft(TEMP, [
      { criterion: 'toF(100) returns 212.', passages: ['P2'], check: fn('lib/temp.js', 'toF', [100], 212) },
      { criterion: 'toF(0) still returns 32.', passages: ['P3'], check: fn('lib/temp.js', 'toF', [0], 32) },
      { criterion: 'toF(-40) returns -40.', passages: ['P2'], check: fn('lib/temp.js', 'toF', [-40], -40) }], { allowed: ['lib/temp.js'] })],
    ['the module named in the sentence disambiguates a duplicate name', 'In lib/a.js, make fmt(5) return "05".',
      draft('In lib/a.js, make fmt(5) return "05".', [{ criterion: 'fmt(5) returns "05".', passages: ['P2'], check: fn('lib/a.js', 'fmt', [5], '05') }], { allowed: ['lib/a.js'] })],
    ['a legitimate request with no literal examples (U1 sentence shape)', 'In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.',
      draft('In lib/users.js, make UserRepo.find() return null for an unknown id instead of throwing.', [
        { criterion: 'UserRepo.find("nope") returns null for an unknown id.', passages: ['P2'], check: method('lib/users.js', 'find', [[['nope'], null]]) }], { allowed: ['lib/users.js'] })],
    ['general rule retained with its sampled example (S1 shape)', 'In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".',
      draft('In lib/slug.js, make slugify() turn each run of spaces into a single dash, so slugify("a  b") returns "a-b" instead of "a--b".', [
        { criterion: 'slugify turns each run of spaces into a single dash: slugify("a  b") returns "a-b" (sampled by this example).', passages: ['P2', 'P3'], check: fn('lib/slug.js', 'slugify', ['a  b'], 'a-b') }], { allowed: ['lib/slug.js'] })],
  ];
  for (const [name, request, raw] of positives) {
    test(`positive control stays valid (today and after): ${name}`, () => assert.equal(stateOf(request, raw).state, 'finalized'));
    t(`positive control: no KAN-107 error: ${name}`, () => assert.deepEqual(RX().exampleErrors(contractFromObject(raw, request)), []));
  }
  t('the error class of a throw example is shown as NOT checked (message_includes checks text, not RangeError identity)', () => {
    const [, request, raw] = positives[1];
    const row = RX().exampleMapping(contractFromObject(raw, request)).find((x) => x.outcome === 'throws');
    assert.equal(row.check_id, 'CHK-1');
    assert.equal(row.error_class, 'RangeError');
    assert.equal(row.error_class_status, 'not_checked');
  });
  t('U2 (known development case): invented expected values with no stated behaviour are refused as requirements', () => {
    const U2 = 'In lib/round.js, make roundTo() handle negative numbers properly.';
    const raw = draft(U2, [
      { criterion: 'roundTo(-1.234, 2) returns -1.23.', passages: ['P2'], check: fn('lib/round.js', 'roundTo', [-1.234, 2], -1.23) },
      { criterion: 'roundTo(-4.567, 1) returns -4.6.', passages: ['P2'], check: fn('lib/round.js', 'roundTo', [-4.567, 1], -4.6) }], { allowed: ['lib/round.js'] });
    assert.match(errorsOf(U2, raw), /P2 .*states no expected behaviour/);
  });
  t('U2 with QB-proposed defaults: valid only as SEPARATE proposed defaults D-n, shown for explicit approval', () => {
    const U2 = 'In lib/round.js, make roundTo() handle negative numbers properly.';
    const raw = draft(U2, [
      { criterion: 'roundTo(-1.234, 2) returns -1.23 (QB-proposed default D-1, not stated by the request).', passages: ['P2'], defaults: ['D-1'], check: fn('lib/round.js', 'roundTo', [-1.234, 2], -1.23) }],
    { allowed: ['lib/round.js'], defaults: [{ id: 'D-1', text: 'negative numbers round half away from zero', reason: 'the request states no expected value' }] });
    const c = contractFromObject(raw, U2);
    assert.deepEqual(RX().exampleErrors(c), []);
    assert.ok(RX().exampleMapping(c).some((x) => x.source === 'proposed_default' && x.check_id === 'CHK-1'));
  });
  t('explicitly specified rounding (contrast with U2): a stated example, checked, is valid', () => {
    const R = 'In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.';
    const raw = draft(R, [{ criterion: 'roundTo rounds negative halves away from zero: roundTo(-2.5, 0) returns -3.', passages: ['P2', 'P3'], check: fn('lib/round.js', 'roundTo', [-2.5, 0], -3) }], { allowed: ['lib/round.js'] });
    assert.deepEqual(RX().exampleErrors(contractFromObject(raw, R)), []);
    assert.equal(RX().extractExamples(R).underspecified.length, 0);
  });
});

// ── integration with the producers (decision 7) ─────────────────────────────
describe('KAN-107 integration: legacy correction, --contract-file, approval view (decisions 1, 7)', () => {
  const { compileIntent } = require('../../intent/session');
  const REQUEST = read104('request.txt').trim();
  async function compileWith(replies) {
    let i = 0;
    const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
    try { const s = await compileIntent(REQUEST); return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages) }; } finally { m.restore(); }
  }
  test('positive (today and after): the faithful greeting draft finalizes with ONE model call', async () => {
    const { s, calls } = await compileWith([read104('faithful-draft.json')]);
    assert.deepEqual([s.state, calls], ['finalized', 1]);
  });
  t('legacy path: the contradictory draft gets the ONE existing correction (with the example error), then stops invalid; no extra call', async () => {
    const C = read104('contradictory-check-draft.json');
    const { s, calls, prompts } = await compileWith([C, C, C]);
    assert.equal(calls, 2, 'one draft plus the one existing correction; no new retry loop');
    assert.equal(s.state, 'invalid');
    assert.match(JSON.stringify(prompts[1]), /has no check with those arguments/);
    assert.match(s.errors.join('\n'), /greeting\("Arshad"\)/);
  });
  t('--contract-file: a contradictory supplied contract is refused as supplied and never rewritten', () => {
    const { loadContractFile } = require('../../intent/contract-file');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-cf-'));
    try {
      const file = path.join(dir, 'c.json');
      fs.writeFileSync(file, read104('contradictory-check-draft.json'));
      const before = fs.readFileSync(file);
      const { contract } = loadContractFile(file, REQUEST);
      assert.equal(contractState(contract).state, 'invalid');
      assert.deepEqual(fs.readFileSync(file), before);
      assert.deepEqual(contract.checks[0].params.args, ['test'], 'the supplied check is not corrected to fit');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  t('approval view: each request example is shown as excerpt -> target/args/expected -> check id', () => {
    const { formatOracle } = require('../../intent/oracle-view');
    const c = contractFromObject(JSON.parse(read104('faithful-draft.json')), REQUEST);
    const view = formatOracle(c);
    assert.match(view, /Request examples/);
    assert.match(view, /greeting\("Arshad"\) returns "Hello, Arshad!".*->.*src\/greeting\.js greeting\(\["Arshad"\]\) returns "Hello, Arshad!".*->.*CHK-1/);
  });
});

// ── the staged compiler (decisions 2, 3, 4, 7) with a FAKE model ────────────
describe('KAN-107 staged compiler with a faked model (KAN-106 development cases, not fresh validation)', () => {
  const { l1Budget } = require('../../lib/budget');
  function makeRepo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-staged-'));
    for (const [rel, body] of Object.entries({ 'package.json': '{"name":"k107","type":"commonjs"}', ...files })) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }
  /** The real staged producer; `reply(calls, rid, user)` is the FAKE model's facts for one requirement (calls: the schema's call labels). */
  async function produce(request, files, reply) {
    const repo = makeRepo(files);
    const m = mockFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      const it = body.format.properties.cases.items.properties;
      const user = body.messages.filter((x) => x.role === 'user').map((x) => x.content).join('\n');
      return { ...ollamaReply(JSON.stringify(reply(it.call.enum, it.requirement.enum[0], user))), model: 'fake-model' };
    });
    try { return { s: await require('../../intent/session').compileIntent(request, { repoPath: repo.dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) }), calls: m.calls.length }; }
    finally { m.restore(); repo.cleanup(); }
  }
  const one = (calls, rid, args, outcome, expected, frag = null, name = null) => ({ cases: [{ requirement: rid, call: name ? calls.find((c) => c.startsWith(name)) : calls[0], args, outcome, expected, error_fragment: frag }] });
  const LIST = { 'lib/list.js': "'use strict'\nfunction first (xs) { return xs[0] }\nmodule.exports = { first }\n" };
  const FIRST = 'In lib/list.js, make first([]) return null.';

  t('bounded literal args in the fact schema: one array, nested arrays to depth 3; deeper or objects refused', () => {
    const { factSchema, schemaErrors } = require('../../intent/staged');
    const args = factSchema({ requirementId: 'R-2', calls: ['first (lib/list.js)'], fragments: 0 }).properties.cases.items.properties.args;
    assert.deepEqual(schemaErrors(args, [[]]), []);
    assert.deepEqual(schemaErrors(args, [['a', 'b']]), []);
    assert.deepEqual(schemaErrors(args, [[[1, 2], [3]]]), []);
    assert.notDeepEqual(schemaErrors(args, [[[[[1]]]]]), []);
    assert.notDeepEqual(schemaErrors(args, [{ a: 1 }]), []);
  });
  t('one empty-array argument: the fake model states args [[]] and the checklist keeps it as ONE argument', async () => {
    const { s } = await produce(FIRST, LIST, (calls, rid) => one(calls, rid, [[]], 'returns', null));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.checks[0].params.args, [[]]);
  });
  t('zero arguments for the request example first([]) is refused (changed argument shape), not finalized', async () => {
    const { s } = await produce(FIRST, LIST, (calls, rid) => one(calls, rid, [], 'returns', null));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /changes the argument shape/);
  });
  t('S2 (development case): a default-class method with ONE array argument is expressible and checked as one argument', async () => {
    const S2 = 'In lib/formatter.js, make Formatter.join() return an empty string for an empty array instead of undefined. Keep join(["a", "b"]) returning "a,b".';
    const files = { 'lib/formatter.js': "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  join (list) {\n    if (list.length === 0) return undefined\n    return list.join(this.separator)\n  }\n}\n" };
    const { s } = await produce(S2, files, (calls, rid) => (rid === 'R-2' ? one(calls, rid, [[]], 'returns', '') : one(calls, rid, [['a', 'b']], 'returns', 'a,b')));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.checks.map((k) => k.params.steps[0].args), [[[]], [['a', 'b']]]);
  });
  t('S2 (development case): the recorded flattened facts (args [] and ["a", "b"]) are refused', async () => {
    const S2 = 'In lib/formatter.js, make Formatter.join() return an empty string for an empty array instead of undefined. Keep join(["a", "b"]) returning "a,b".';
    const files = { 'lib/formatter.js': "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  join (list) {\n    if (list.length === 0) return undefined\n    return list.join(this.separator)\n  }\n}\n" };
    const { s } = await produce(S2, files, (calls, rid) => (rid === 'R-2' ? one(calls, rid, [], 'returns', '') : one(calls, rid, ['a', 'b'], 'returns', 'a,b')));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /changes the argument shape of the request's example join\(\["a", "b"\]\)/);
  });
  t('S3 (development case): the request-sourced message is offered as a fragment for the NEW export and lands in the check', async () => {
    const S3 = 'In lib/math.js, create and export a function percent(part, whole) that returns part / whole * 100 rounded to the nearest whole number, for example percent(1, 3) returns 33 and percent(2, 3) returns 67. When whole is 0 it must throw an error whose message includes "whole must not be zero". Keep add(2, 3) returning 5.';
    const files = { 'lib/math.js': "'use strict'\nfunction add (a, b) { return a + b }\nmodule.exports = { add }\n" };
    const fragNo = (user) => { const m = [...user.matchAll(/^(\d+): (".*")$/gm)].find((x) => JSON.parse(x[2]).includes('whole must not be zero')); return m ? Number(m[1]) : null; };
    const { s } = await produce(S3, files, (calls, rid, user) => {
      const pct = calls.find((c) => c.startsWith('percent'));
      if (rid === 'R-5') return one(calls, rid, [2, 3], 'returns', 5, null, 'add');
      if (rid === 'R-4') return one(calls, rid, [1, 0], 'throws', null, fragNo(user), 'percent');
      return { cases: [{ requirement: rid, call: pct, args: [1, 3], outcome: 'returns', expected: 33, error_fragment: null }, { requirement: rid, call: pct, args: [2, 3], outcome: 'returns', expected: 67, error_fragment: null }] };
    });
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    const k = s.contract.checks.find((x) => x.adapter === 'call_throws');
    assert.equal(k.params.message_includes, 'whole must not be zero');
  });
  t('U2 (development case): an underspecified change stops BEFORE any model call (clarify/refuse), nothing invented', async () => {
    const U2 = 'In lib/round.js, make roundTo() handle negative numbers properly.';
    const files = { 'lib/round.js': "'use strict'\n\nfunction roundTo (n, places) {\n  const f = 10 ** places\n  return Math.round(n * f) / f\n}\n\nmodule.exports = { roundTo }\n" };
    const { s, calls } = await produce(U2, files, (calls, rid) => one(calls, rid, [-1.234, 2], 'returns', -1.23));
    assert.equal(calls, 0);
    assert.notEqual(s.state, 'finalized');
    assert.match(JSON.stringify(s.errors || s.unresolved || ''), /states no expected behaviour|clarif/);
  });
  test('positive (today and after): explicit rounding, the fake model states the request example exactly: finalized', async () => {
    const R = 'In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.';
    const files = { 'lib/round.js': "'use strict'\n\nfunction roundTo (n, places) {\n  const f = 10 ** places\n  return Math.round(n * f) / f\n}\n\nmodule.exports = { roundTo }\n" };
    const { s } = await produce(R, files, (calls, rid) => one(calls, rid, [-2.5, 0], 'returns', -3));
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.checks[0].params.args, [-2.5, 0]);
  });
  t('explicit rounding (contrast): the fake model drops an argument of the stated example roundTo(-2.5, 0): refused', async () => {
    const R = 'In lib/round.js, make roundTo() round negative halves away from zero, so roundTo(-2.5, 0) returns -3.';
    const files = { 'lib/round.js': "'use strict'\n\nfunction roundTo (n, places) {\n  const f = 10 ** places\n  return Math.round(n * f) / f\n}\n\nmodule.exports = { roundTo }\n" };
    const { s } = await produce(R, files, (calls, rid) => one(calls, rid, [-2.5], 'returns', -3));
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /roundTo\(-2\.5, 0\).*has no check with those arguments|has no executable check/);
  });
});
