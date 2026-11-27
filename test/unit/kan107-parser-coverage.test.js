/**
 * KAN-107 senior 10847: parser coverage for intent/request-examples.js where the earlier tests were thin (literal
 * edge cases, argument lists, result shapes, message clauses, polarity branches, sentence and passage edges).
 * Each case states what QB does today; cases marked KNOWN LIMITATION record a gap on purpose (fail-closed or
 * not enforced, never a guessed requirement). Pure parsing: no repository, no model.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const RX = require('../../intent/request-examples');

const lit = (t) => RX.parseLiteral(t);
const ex = (r) => RX.extractExamples(r).examples.map((e) => [e.receiver, e.name, e.args, e.outcome, e.expected === undefined ? null : e.expected, e.error_class, e.message && [e.message.mode, e.message.fragment]]);
const un = (r) => RX.extractExamples(r).unsupported.map((u) => [u.kind, u.reason]);

describe('literals (no eval)', () => {
  test('strings: escapes, \\u, single quotes, non-ASCII; refused: unterminated, unknown escape, template', () => {
    assert.deepEqual(lit('"a\\u0041\\n\\t\\"q\\""'), { ok: true, value: 'aA\n\t"q"' });
    assert.deepEqual(lit("'x'"), { ok: true, value: 'x' });
    assert.deepEqual(lit('"é"'), { ok: true, value: 'é' });
    assert.deepEqual(lit('"abc'), { ok: false, reason: 'an unterminated string' });
    assert.deepEqual(lit('"a\nb"'), { ok: false, reason: 'an unterminated string' }, 'a string never spans a line break');
    assert.deepEqual(lit('"a\\q"'), { ok: false, reason: 'an unsupported escape in a string' });
    assert.deepEqual(lit('`t`'), { ok: false, reason: 'template strings are unsupported' });
  });
  test('numbers: sign, fraction, exponent; refused: leading zeros, a bare exponent, NaN, Infinity', () => {
    assert.deepEqual(lit('-1.5e3'), { ok: true, value: -1500 });
    assert.deepEqual(lit('  7  '), { ok: true, value: 7 });
    assert.equal(lit('01').ok, false);
    assert.equal(lit('1e').ok, false);
    assert.deepEqual(lit('NaN'), { ok: false, reason: 'NaN is not JSON' });
    assert.deepEqual(lit('Infinity'), { ok: false, reason: 'Infinity is not JSON' });
    assert.deepEqual(lit('undefined'), { ok: false, reason: 'undefined is not JSON' });
  });
  test('keywords and identifiers; objects and expressions are refused, never evaluated', () => {
    assert.deepEqual([lit('true'), lit('false'), lit('null')].map((x) => x.value), [true, false, null]);
    assert.deepEqual(lit('foo'), { ok: false, reason: 'foo is an identifier or variable, not a literal' });
    assert.deepEqual(lit('{a:1}'), { ok: false, reason: 'object literals are unsupported in v1' });
    assert.deepEqual(lit('1+2'), { ok: false, reason: 'expressions are unsupported' });
    assert.deepEqual(lit('[1,2'), { ok: false, reason: 'not a literal array' });
    assert.deepEqual(lit('[1,[2,[3]]]'), { ok: true, value: [1, [2, [3]]] });
    assert.deepEqual(lit('[[[[1]]]]'), { ok: false, reason: 'nesting depth over 3' });
  });
  test('valueErrors reports non-JSON values (defensive: never produced by the parser)', () => {
    assert.deepEqual(RX.valueErrors(undefined), ['value: not JSON (undefined)']);
    assert.deepEqual(RX.valueErrors(() => 1), ['value: not JSON (function)']);
  });
  test('argument lists: empty, mixed, nested; refused: trailing comma, a variable, missing comma', () => {
    assert.deepEqual(RX.parseArgs(''), { ok: true, value: [] });
    assert.deepEqual(RX.parseArgs('1, "a", [2]'), { ok: true, value: [1, 'a', [2]] });
    assert.deepEqual(RX.parseArgs('[], []'), { ok: true, value: [[], []] });
    assert.equal(RX.parseArgs('1,').ok, false);
    assert.match(RX.parseArgs('x, 1').reason, /x is an identifier/);
    assert.deepEqual(RX.parseArgs('1 2'), { ok: false, reason: 'not a literal argument list' });
  });
});

describe('call examples: shapes QB reads', () => {
  test('"with no arguments", a receiver, negative numbers, single quotes, arrays in and out', () => {
    assert.deepEqual(ex('In lib/a.js, make f() with no arguments return 0.'), [[null, 'f', [], 'returns', 0, null, null]]);
    assert.deepEqual(ex('In lib/a.js, make Obj.f(1) return 2.'), [['Obj', 'f', [1], 'returns', 2, null, null]]);
    assert.deepEqual(ex('In lib/a.js, make f(-0.5) return -1.'), [[null, 'f', [-0.5], 'returns', -1, null, null]]);
    assert.deepEqual(ex("In lib/a.js, make f('x') return 'y'."), [[null, 'f', ['x'], 'returns', 'y', null, null]]);
    assert.deepEqual(ex('In lib/a.js, make f(1) return "it\'s".'), [[null, 'f', [1], 'returns', "it's", null, null]]);
    assert.deepEqual(ex('In lib/a.js, make f([1, 2]) return [2, 1].'), [[null, 'f', [[1, 2]], 'returns', [2, 1], null, null]]);
  });
  test('throws: an error class (shown, not checked), "whose message is" (equals), "with the message", "and its message includes"', () => {
    assert.deepEqual(ex('In lib/a.js, make f("") throw a TypeError whose message is "empty".'), [[null, 'f', [''], 'throws', null, 'TypeError', ['equals', 'empty']]]);
    assert.deepEqual(ex('In lib/a.js, make f("") throw an error with the message "empty".'), [[null, 'f', [''], 'throws', null, null, ['equals', 'empty']]]);
    assert.deepEqual(ex('In lib/a.js, make f("") throw an error, and its message includes "empty".'), [[null, 'f', [''], 'throws', null, null, ['includes', 'empty']]]);
  });
  test('trailing words that keep an example: "instead", "still", a second sentence with "Then"; a dot inside a string is not a sentence end', () => {
    assert.deepEqual(ex('In lib/a.js, make f(1) return 2 instead.'), [[null, 'f', [1], 'returns', 2, null, null]]);
    assert.deepEqual(ex('In lib/a.js, make f(1) still return 2.'), [[null, 'f', [1], 'returns', 2, null, null]]);
    assert.deepEqual(ex('In lib/a.js, make f(1) return "a.b". Then make g(2) return 3.').map((e) => [e[1], e[4]]), [['f', 'a.b'], ['g', 3]]);
  });
  test('the same result stated twice is two examples and no conflict', () => {
    const r = RX.extractExamples('In lib/a.js, make f(1) return 2. Make f(1) return 2.');
    assert.equal(r.examples.length, 2);
    assert.deepEqual(r.conflicts, []);
  });
});

describe('call examples: shapes QB refuses to enforce (reported, never guessed)', () => {
  const kinds = (r) => un(r).map(([k]) => k);
  test('a condition, prose, an object, a template or an expression as the result', () => {
    assert.match(un('In lib/a.js, make f(1) return 2 for positive inputs.')[0][1], /conditional prose/);
    assert.match(un('In lib/a.js, make f(1) return 2 when the cache is warm.')[0][1], /conditional prose/);
    assert.match(un('In lib/a.js, make f(1) return the sum.')[0][1], /the result is prose/);
    assert.match(un('In lib/a.js, make f(1) return { a: 1 }.')[0][1], /object literals are unsupported/);
    assert.match(un('In lib/a.js, make f(1) return `x`.')[0][1], /template strings/);
    assert.match(un('In lib/a.js, make f(1) return 1 + 1.')[0][1], /trailing prose after the result/);
    assert.deepEqual(kinds('In lib/a.js, make f(x) return 2.'), ['variable']);
  });
  test('polarity: a question, a code condition, a current-behaviour description after "keep", a negated clause', () => {
    assert.match(un('In lib/a.js, should f(1) return 2?')[0][1], /part of a question/);
    assert.match(un('In lib/a.js, if (x) f(1) returns 2.')[0][1], /reads as a condition/);
    assert.match(un('In lib/a.js, keep the broken f(1) returning 2.')[0][1], /reads as the current behaviour/);
    const neg = RX.extractExamples('In lib/a.js, do not make f(1) return 2; make f(1) return 3.');
    assert.deepEqual(neg.examples.map((e) => e.expected), [3]);
    assert.match(neg.unsupported[0].reason, /something the request rules out/);
  });
  test('"For example" takes the polarity of the instruction before it: an addition is enforced, a bare "Fix" is not', () => {
    assert.deepEqual(ex('Add f in lib/a.js. For example, f(1) returns 2.').map((e) => e[4]), [2]);
    assert.deepEqual(ex('Fix lib/a.js. For example, f(1) returns 2.'), []);
    assert.match(un('Fix lib/a.js. For example, f(1) returns 2.')[0][1], /may be the current behaviour/);
  });
  test('a contrast keeps both sides apart: "currently" after ";" is a description, the wanted call stays', () => {
    const r = RX.extractExamples('In lib/a.js, make f(1) return 2; currently f(1) returns 3.');
    assert.deepEqual(r.examples.map((e) => e.expected), [2]);
    assert.match(r.unsupported[0].reason, /the current behaviour/);
    assert.deepEqual(r.conflicts, [], 'a description is not a second wanted result');
  });
  test('KNOWN LIMITATION: an unbalanced or mismatched call is neither an example nor reported as unsupported; the passage stays a rule that must be retained', () => {
    for (const r of ['In lib/a.js, make f(1 return 2.', 'In lib/a.js, make f(1] return 2.']) {
      const x = RX.extractExamples(r);
      assert.deepEqual([x.examples, x.unsupported], [[], []], r);
      assert.equal(x.rules.length, 1, r);
    }
  });
});

describe('quoted messages outside call examples', () => {
  test('a "when <param> is <literal>" condition binds to the one signature written in the request', () => {
    const [m] = RX.extractExamples('In lib/a.js, change percent(part, whole). When whole is 0 it must throw an error whose message includes "zero".').messages;
    assert.deepEqual([m.fragment, m.name, m.condition.bound, m.condition.index, m.condition.arity, m.condition.value], ['zero', 'percent', true, 1, 2, 0]);
  });
  test('a condition naming no written parameter stays unbound (refused later, never guessed)', () => {
    const [m] = RX.extractExamples('In lib/a.js, when x is 0 it must throw an error whose message includes "zero".').messages;
    assert.deepEqual([m.condition.bound, m.condition.reason, m.name], [false, 'no call signature in the request names that parameter', null]);
  });
  test('an edit instruction makes a message wanted; a call with variable arguments is unsupported but its message is still required of that function', () => {
    const r = RX.extractExamples('In lib/a.js, update parse(s) to throw an error whose message includes "bad".');
    assert.deepEqual(r.examples, []);
    assert.match(r.unsupported[0].reason, /s is an identifier/);
    assert.deepEqual(r.messages.map((m) => [m.fragment, m.name]), [['bad', 'parse']]);
  });
  test('no call named at all: the message is kept with no target (the contract error asks which call)', () => {
    const r = RX.extractExamples('In lib/a.js, update parse so it throws an error whose message includes "bad".');
    assert.deepEqual(r.messages.map((m) => [m.fragment, m.name]), [['bad', null]]);
  });
});

describe('underspecified wording (small vague-qualifier list)', () => {
  test('"gracefully" with no stated result is underspecified, not a rule', () => {
    const r = RX.extractExamples('In lib/a.js, make f() handle bad input gracefully.');
    assert.deepEqual([r.underspecified.map((u) => u.qualifier), r.rules.length], [['gracefully'], 0]);
  });
});
