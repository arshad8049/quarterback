/**
 * KAN-107 (senior 10805): rulings 1 and 3 on 1ff7c66. OFFLINE: the model is faked, QB_OLLAMA_URL is a dead port.
 *
 * Ruling 1: only an explicit positive desired-result clause makes a call example (or a quoted error message)
 * enforceable. Current-bug descriptions, negated clauses and unresolved polarity are shown as not checked, never
 * turned into a requirement. A correct check must not be rejected in favour of the old or forbidden value.
 * Ruling 3: a request that names no file is not invalid in itself. A target is used only when QB's own grounding
 * resolves it uniquely; otherwise QB asks which file. It is never taken from the checks or the allowed files.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { contractFromObject } = require('../../intent/compiler');
const { contractState } = require('../../intent/contract-state');
const { groundApi, contractGrounding } = require('../../intent/api-grounding');
const { splitPassages } = require('../../intent/passages');
const { draft, fn, throwsFn } = require('../fixtures/kan107/build');

process.env.QB_OLLAMA_URL = 'http://127.0.0.1:9';
const RX = require('../../intent/request-examples');

const BUG = 'In lib/x.js, fix the bug where f(1) returns 2 instead of 3.';
const NEG = 'In lib/x.js, do not make f(1) return 2.';
const MIXED = 'In lib/x.js, f(1) returns 2 today; make f(1) return 3.';

const values = (r) => RX.extractExamples(r).examples.map((e) => (e.outcome === 'throws' ? `${e.call} throws` : `${e.call}=${JSON.stringify(e.expected)}`));
/** A draft citing every passage that names the call, with one check. */
function one(request, check, o = {}) {
  const cite = splitPassages(request).filter((p) => /\bf\(/.test(p.text)).map((p) => p.id);
  return draft(request, [{ criterion: 'f behaves as requested.', passages: cite, check }], { allowed: ['lib/x.js'], ...o });
}
const contract = (request, raw, g = null) => { const c = contractFromObject(raw, request); if (g) c.api_grounding = g; return c; };
const stateOf = (request, raw, g) => contractState(contract(request, raw, g));
const why = (s) => (s.errors || []).join('\n');
const not_checked = (request) => RX.extractExamples(request).unsupported;

describe('KAN-107 10805 ruling 1: extraction polarity', () => {
  test('the two reproduced strings: neither the bug value nor the forbidden value is an example', () => {
    assert.deepEqual(values(BUG), []);
    assert.deepEqual(values(NEG), []);
  });
  test('mixed current and desired behaviour in one sentence: only the desired value is enforceable', () => {
    assert.deepEqual(values(MIXED), ['f(1)=3']);
    assert.deepEqual(values('In lib/x.js, fix the bug where f(1) returns 2: make f(1) return 3.'), ['f(1)=3']);
    assert.deepEqual(values('In lib/x.js, currently f(1) returns 2, but make f(1) return 3.'), ['f(1)=3']);
    assert.deepEqual(values('In lib/x.js, make f(1) return 3 (currently f(1) returns 2).'), ['f(1)=3']);
  });

  // [request, why it is not a positive requirement]
  const never = [
    ['In lib/x.js, fix the bug where f(1) returns 2 and f(2) returns 4.', 'bug list'],
    ['In lib/x.js, fix the problem that f(1) returns 2.', 'problem that'],
    ['In lib/x.js, fix f(1) returning 2.', 'fix + gerund: fix what?'],
    ['In lib/x.js, change f(1) returning 2.', 'change from what?'],
    ['In lib/x.js, update f because f(1) returns 2.', 'reason clause'],
    ['In lib/x.js, the bug makes f(1) return 2.', 'a bug makes it'],
    ['In lib/x.js, a rounding error can make f(1) return 2.', 'can make'],
    ['In lib/x.js, fix the bug causing f(1) to return 2.', 'causing … to return'],
    ['In lib/x.js, rounding is broken so f(1) returns 2.', 'declarative so'],
    ['In lib/x.js, f should round up but f(1) returns 2.', 'contrast after should'],
    ['In lib/x.js, f should round up, f(1) returns 2.', 'should does not govern the call'],
    ['In lib/x.js, fix the bug where f(1) still returns 2.', 'still inside a bug clause'],
    ['In lib/x.js, after the last fix f(1) still returns 2.', 'still, polarity unresolved'],
    ['In lib/x.js, never make f(1) return 2.', 'never'],
    ["In lib/x.js, don't make f(1) return 2.", "don't"],
    ['In lib/x.js, don’t make f(1) return 2.', 'typographic apostrophe'],
    ['In lib/x.js, do not ever make f(1) return 2.', 'do not ever'],
    ['In lib/x.js, do not, under any circumstances, make f(1) return 2.', 'negation over a comma phrase'],
    ['In lib/x.js, do not change f so that f(1) returns 2.', 'negated change … so that'],
    ['In lib/x.js, avoid changes that make f(1) return 2.', 'avoid'],
    ['In lib/x.js, stop f from drifting so f(1) returns 2.', 'stop: unresolved'],
    ['In lib/x.js, it is not expected that f(1) returns 2.', 'not expected'],
    ['In lib/x.js, make sure it is no longer the case that f(1) returns 2.', 'no longer'],
    ['In lib/x.js, make sure f rounds up rather than f(1) returning 2.', 'rather than'],
    ['In lib/x.js, make sure f rounds up instead of f(1) returning 2.', 'instead of'],
    ['In lib/x.js, should f(1) return 2?', 'a question'],
    ['In lib/x.js, why does f(1) return 2?', 'a question'],
    ['In lib/x.js, make sure that if f(1) returns 2 the caller retries.', 'a condition'],
    ['In lib/x.js, f(1) returns 2.', 'bare: disclosed v1 limitation'],
    ['In lib/x.js, the parser is wrong. For example, f(1) returns 2.', 'example of a bug'],
    ['In lib/x.js, f is buggy, for example f(1) returns 2.', 'example of a bug, one sentence'],
    ['In lib/x.js, fix f, it rounds down so f(1) returns 2.', 'a description after the edit, then so'],
    ['In lib/x.js, fix f, rounding is off so f(1) returns 2.', 'a comma clause, then so'],
    ['In lib/x.js, fix the function that rounds down so f(1) returns 2.', 'a relative clause, then so'],
    ['In lib/x.js, fix the rounding in f, for example f(1) returns 2.', 'fix + example: of the bug or of the result?'],
    ['In lib/x.js, fix f. For example, f(1) returns 2.', 'the same over two sentences'],
    ['In lib/x.js, make sure nothing makes f(1) return 2.', 'nothing makes'],
    ['In lib/x.js, make it impossible that f(1) returns 2.', 'impossible'],
    ["In lib/x.js, I don't want f(1) to return 2.", "don't want"],
    ['In lib/x.js, Bug: f(1) returns 2.', 'Bug: label'],
    ['In lib/x.js, Actual: f(1) returns 2.', 'Actual: label'],
    ['In lib/x.js, fix the bug where f(1) throws an error whose message includes "bad".', 'bug throw'],
    ['In lib/x.js, do not make f(1) throw an error whose message includes "bad".', 'negated throw'],
  ];
  for (const [request, label] of never) {
    test(`not a requirement (${label}): ${request}`, () => {
      assert.deepEqual(values(request), [], request);
      const u = not_checked(request).filter((x) => /f\(1\)/.test(x.excerpt));
      if (!/why does|should f/.test(request)) assert.ok(u.length >= 1, `shown as not checked: ${JSON.stringify(not_checked(request))}`);
      for (const x of u) assert.match(x.reason, /QB does not enforce it.*write "make /, 'a useful clarification');
    });
  }
  describe('two results asked for the same call (10812): surfaced for the human, never one picked', () => {
    const R = 'In lib/x.js, make f(1) return 3. Make f(1) return 2.';
    test('neither is an example; both stay visible as not checked', () => {
      assert.deepEqual(values(R), []);
      assert.equal(not_checked(R).filter((u) => /two different results/.test(u.reason)).length, 2);
    });
    for (const v of [2, 3]) {
      test(`a contract that picks ${v} is refused before approval, and the error asks which result is wanted`, () => {
        const s = stateOf(R, one(R, fn('lib/x.js', 'f', [1], v)));
        assert.equal(s.state, 'invalid');
        assert.match(why(s), /the request states different results for f\(1\): returns 3 and returns 2\. Which one is wanted\?/);
      });
    }
    test('return versus throw for the same call is a conflict too; the same result twice is not', () => {
      assert.equal(RX.extractExamples('In lib/x.js, make f(1) return 3. Make f(1) throw an error.').conflicts.length, 1);
      const same = RX.extractExamples('In lib/x.js, make f(1) return 3. Keep f(1) returning 3.');
      assert.equal(same.conflicts.length, 0);
      assert.equal(same.examples.length, 2);
    });
    // 10835 split: the staged stop-before-any-call twin stays with the staged prototype (kan107-consistency-design).
    test('a bug-report sentence beside the wanted one is not a conflict', () => {
      assert.deepEqual(RX.extractExamples(MIXED).conflicts, []);
    });
  });

  // positives that must keep working
  const wanted = [
    ['In lib/x.js, make f(1) return 3.', ['f(1)=3']],
    ['In lib/x.js, make f(1) return 3 instead of 2.', ['f(1)=3']],
    ['In lib/x.js, make f(1) return 3 and f(2) return 4.', ['f(1)=3', 'f(2)=4']],
    ['In lib/x.js, f(1) should return 3.', ['f(1)=3']],
    ['In lib/x.js, f(1) must return 3.', ['f(1)=3']],
    ['In lib/x.js, f(1) must still return 3.', ['f(1)=3']],
    ['In lib/x.js, change f(1) to return 3.', ['f(1)=3']],
    ['In lib/x.js, I want f(1) to return 3.', ['f(1)=3']],
    ['In lib/x.js, ensure that f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, make sure f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, update f so f(1) returns 3 instead of 2.', ['f(1)=3']],
    ['In lib/x.js, fix f so that f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, fix the rounding bug so f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, keep f(0) returning 1.', ['f(0)=1']],
    ['In lib/x.js, preserve f(0) returning 1.', ['f(0)=1']],
    ['In lib/x.js, make f(1) return 3 instead of 2 and make f(2) return 4.', ['f(1)=3', 'f(2)=4']],
    ['In lib/x.js, make f(1) return 3 instead of 2, and keep f(0) returning 1.', ['f(1)=3', 'f(0)=1']],
    ['In lib/x.js, make f(1) return 3 instead of 2 and f(2) return 4.', ['f(1)=3', 'f(2)=4']],
    ['In lib/x.js, make f(1) return "a" instead of "b" and keep f(0) returning 1.', ['f(1)="a"', 'f(0)=1']],
    ['In lib/x.js, f(1) returns 2, f(1) should return 3.', ['f(1)=3']],
    ['In lib/x.js, fix it so that f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, make f() show hours once the time reaches one hour, so f(1) returns "1:00" instead of "60:00".', ['f(1)="1:00"']],
    ["f(1) should return '30s' instead of '0m 30s' and f(2) should still return '1m 30s'.", ["f(1)=\"30s\"", "f(2)=\"1m 30s\""]],
    ['In lib/x.js, make f(1) return 3 but keep f(0) returning 1.', ['f(1)=3', 'f(0)=1']],
    ['Do not change package.json; in lib/x.js make f(1) return 3.', ['f(1)=3']],
    ['In lib/x.js, do not change the signature, but make f(1) return 3.', ['f(1)=3']],
    ['In lib/x.js, create and export a function f(n) that rounds up, for example f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, make f round up. For example, f(1) returns 3.', ['f(1)=3']],
    ['In lib/x.js, make f(1) throw an error whose message includes "bad".', ['f(1) throws']],
    ['In lib/x.js, make f("do not make") return "where".', ['f("do not make")="where"']],
  ];
  for (const [request, want] of wanted) test(`still a requirement: ${request}`, () => assert.deepEqual(values(request), want, request));

  test('quoted error messages outside a call example have the same polarity rule', () => {
    const msgs = (r) => RX.extractExamples(r).messages.map((m) => m.fragment);
    assert.deepEqual(msgs('In lib/x.js, fix the bug where f(n) throws an error whose message includes "bad".'), []);
    assert.deepEqual(msgs('In lib/x.js, do not let f(n) throw an error whose message includes "bad".'), []);
    assert.deepEqual(msgs('In lib/x.js, f(n) must not throw an error whose message includes "bad".'), []);
    assert.deepEqual(msgs('In lib/x.js, f(n) currently throws an error whose message includes "bad".'), []);
    assert.deepEqual(msgs('In lib/x.js, create f(n). When n is 0 it must throw an error whose message includes "bad".'), ['bad']);
    for (const r of ['In lib/x.js, fix the bug where f(n) throws an error whose message includes "bad".', 'In lib/x.js, f(n) must not throw an error whose message includes "bad".']) {
      assert.ok(not_checked(r).some((u) => /bad/.test(u.excerpt) && /QB does not enforce it/.test(u.reason)), JSON.stringify(not_checked(r)));
    }
  });
});

describe('KAN-107 10805 ruling 1: through contractState and the compilers (fake model)', () => {
  test('the bug report: a check for the correct value 3 finalizes', () => {
    const s = stateOf(BUG, one(BUG, fn('lib/x.js', 'f', [1], 3)));
    assert.equal(s.state, 'finalized', why(s));
  });
  test('the negated request: a check for another value is not called contradictory', () => {
    const s = stateOf(NEG, one(NEG, fn('lib/x.js', 'f', [1], 3)));
    assert.equal(s.state, 'finalized', why(s));
  });
  test('the negated throw: a check that f(1) returns is not called contradictory', () => {
    const R = 'In lib/x.js, do not make f(1) throw an error whose message includes "bad".';
    const s = stateOf(R, one(R, fn('lib/x.js', 'f', [1], 3)));
    assert.equal(s.state, 'finalized', why(s));
  });
  test('the mixed sentence: 3 finalizes, the old value 2 is rejected', () => {
    const good = stateOf(MIXED, one(MIXED, fn('lib/x.js', 'f', [1], 3)));
    assert.equal(good.state, 'finalized', why(good));
    const bad = stateOf(MIXED, one(MIXED, fn('lib/x.js', 'f', [1], 2)));
    assert.equal(bad.state, 'invalid');
    assert.match(why(bad), /contradicts the request's example f\(1\) returns 3/);
  });
  test('the approval rows show the bug value as not checked, with the clarification', () => {
    const rows = RX.exampleMapping(contract(BUG, one(BUG, fn('lib/x.js', 'f', [1], 3))));
    assert.ok(rows.some((r) => r.status === 'unsupported' && /f\(1\) returns 2/.test(r.excerpt) && /QB does not enforce it/.test(r.reason)), JSON.stringify(rows));
    assert.ok(!rows.some((r) => r.status === 'checked'));
    const { formatOracle } = require('../../intent/oracle-view');
    assert.match(formatOracle(contract(BUG, one(BUG, fn('lib/x.js', 'f', [1], 3)))), /f\(1\) returns 2[\s\S]*QB does not enforce it/);
  });
  for (const [label, request] of [['bug report', BUG], ['mixed sentence', MIXED]]) {
    test(`legacy compiler, ${label}: the draft with the correct value finalizes with ONE model call (no correction toward the old value)`, async () => {
      const { compile } = require('../../intent/compiler');
      const raw = one(request, fn('lib/x.js', 'f', [1], 3));
      const m = mockFetch(() => ollamaReply(JSON.stringify(raw)));
      try {
        const c = await compile(request, []);
        assert.equal(contractState(c).state, 'finalized', why(contractState(c)));
      } finally { m.restore(); }
      assert.equal(m.calls.length, 1);
    });
  }
});

describe('KAN-107 10805 ruling 3: a request that names no file', () => {
  const R = 'Make f(1) return 3.';
  const check = fn('lib/x.js', 'f', [1], 3);
  const raw = () => draft(R, [{ criterion: 'f(1) returns 3.', passages: ['P1'], check }], { allowed: ['lib/x.js'] });
  const X = "'use strict'\nfunction f (n) { return n }\nmodule.exports = { f }\n";
  const repo = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107p-'));
    for (const [rel, body] of Object.entries({ 'package.json': '{"name":"k","type":"commonjs"}', ...files })) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  };
  /** QB's real grounding of the named modules (`of` names them; the contract's own request names none). */
  const grounding = (files, of) => { const d = repo(files); try { return contractGrounding(groundApi(d, of)); } finally { fs.rmSync(d, { recursive: true, force: true }); } };

  test('no file and no grounding: a clear question, never the module of the check or of allowed_changes', () => {
    const s = stateOf(R, raw());
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /f\(1\) returns 3.*cannot be tied to one target.*Which file contains f\?/);
  });
  test('the producer today: groundApi reads only request-named modules, so a no-file request has no grounded module', () => {
    const g = grounding({ 'lib/x.js': X }, R);
    assert.deepEqual((g && g.modules) || [], []);
    assert.match(why(stateOf(R, raw(), g)), /Which file contains f\?/);
  });
  test('unique trustworthy grounding: accepted (the resolver fallback), and the same check is enforced', () => {
    const g = grounding({ 'lib/x.js': X }, 'In lib/x.js, make f(1) return 3.');
    const ok = stateOf(R, raw(), g);
    assert.equal(ok.state, 'finalized', why(ok));
    const bad = draft(R, [{ criterion: 'f(1) returns 3.', passages: ['P1'], check: fn('lib/x.js', 'f', [1], 2) }], { allowed: ['lib/x.js'] });
    assert.match(why(stateOf(R, bad, g)), /contradicts the request's example f\(1\) returns 3/);
  });
  test('several grounded definitions: a clear question naming them, never a guess', () => {
    const g = grounding({ 'lib/x.js': X, 'lib/y.js': X }, 'In lib/x.js and lib/y.js, make f(1) return 3.');
    const s = stateOf(R, raw(), g);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /cannot be tied to one target.*lib\/x\.js.*lib\/y\.js.*Which file/);
  });
  test('a grounded module that does not define it does not resolve it', () => {
    const g = grounding({ 'lib/x.js': "'use strict'\nmodule.exports = { other () { return 1 } }\n" }, 'In lib/x.js, make other() return 3.');
    assert.match(why(stateOf(R, raw(), g)), /Which file contains f\?/);
  });
});
