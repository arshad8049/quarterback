/**
 * KAN-106, senior decision 10694 (on e5cb7df): one bounded extension so L1 can express the two
 * essential error checks. A call_sequence step may carry `throws: { message_includes }` instead
 * of `expect` (mutually exclusive). Only the invoked METHOD's synchronous throw or awaited
 * rejection satisfies it; construction errors, a missing export or method, setup errors,
 * timeouts, process exits and runner failures never do. Old steps and approved content are
 * unchanged (same registry version and hashes when no step uses `throws`); a runner that does not
 * declare the capability has its results refused, never silently ignored.
 * Also (10694 caution): an existence-only module_exports check cannot stand in for a behavioural
 * criterion such as "asNumber throws". No model, no Claude, no Docker.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const REQUEST = read('request.txt').trim();
const HONEST = read('pinned-api-honest.json');
const THROWS = read('pinned-api-throws.json');
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const FRAGMENT = 'cannot be converted to a number';
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');
const TREE = 'f'.repeat(40);

const registry = () => require('../../verify/checks/registry');
const compiler = () => require('../../intent/compiler');
const state = () => require('../../intent/contract-state');
const variant = (text, edit) => { const d = JSON.parse(text); edit(d); return JSON.stringify(d); };
function contractOf(text) {
  const { resolveInRequest } = require('../../intent/passages');
  const raw = JSON.parse(text);
  raw.requirements = raw.requirements.map((r) => (r.passage_ids ? { ...r, quote: resolveInRequest(REQUEST, r.passage_ids).text } : r));
  return compiler().contractFromObject(raw, REQUEST);
}
const errorsOf = (text, edit = null) => { const s = state().contractState(contractOf(edit ? variant(text, edit) : text)); return s.state === 'finalized' ? [] : s.errors; };

/** Run checks with the REAL runner against a temporary repository holding `files`. */
function runIn(files, checks, { timeoutMs = 5000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-10694-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","type":"commonjs"}');
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
    const out = path.join(dir, 'results.json');
    const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: dir, checks }), encoding: 'utf8',
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: String(timeoutMs) }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(out, 'utf8');
    return { text, doc: JSON.parse(text), byId: Object.fromEntries(JSON.parse(text).results.map((x) => [x.id, x])) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const pinned = (checks, { base = false } = {}) => runIn({ 'lib/serializer.js': base ? PINNED.replace(GUARD, '') : PINNED }, checks);

const seq = (id, steps, { exp = 'Thing', construct = 'new', module = 'lib/thing.js' } = {}) => ({ id, ac_id: 'AC-1', adapter: 'call_sequence',
  params: { module, export: exp, instances: { s: { construct, args: [] } }, steps } });
const throwsStep = (method, args = [], message_includes = 'boom') => ({ on: 's', method, args, throws: { message_includes } });

const THING = `
class Thing {
  sync () { throw new Error('boom: sync') }
  async rejects () { throw new Error('boom: async') }
  wrong () { throw new Error('something else') }
  quiet () { return 42 }
  hang () { for (;;) {} }
  bye () { process.exit(0) }
  get trap () { throw new Error('boom: getter') }
}
class Broken { constructor () { throw new Error('boom: constructor') } }
module.exports = { Thing, Broken, notAClass: 7 }
`;

describe('10694: the registry accepts `throws` on a call_sequence step, narrowly', () => {
  const ok = (steps) => registry().validateChecks([seq('C', steps)], [{ id: 'AC-1' }]);
  test('a step may assert a throw instead of a value; a check of only throws steps is valid', () => {
    const r = ok([throwsStep('sync')]);
    assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
    assert.deepEqual(r.accepted[0].params.steps[0].throws, { message_includes: 'boom' });
  });
  test('expect and throws on the same step conflict', () => {
    const r = ok([{ ...throwsStep('sync'), expect: 1 }]);
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0].reason, /expect and throws are mutually exclusive/);
  });
  test('throws needs a non-empty bounded literal message fragment and nothing else', () => {
    for (const bad of [{}, { message_includes: '' }, { message_includes: '   ' }, { message_includes: 'x'.repeat(201) }, { message_includes: 'boom', type: 'TypeError' }, { message_includes: 3 }]) {
      const r = ok([{ on: 's', method: 'sync', args: [], throws: bad }]);
      assert.equal(r.accepted.length, 0, JSON.stringify(bad));
    }
  });
  test('a step with neither expect nor throws is still allowed (setup), but the check needs at least one assertion', () => {
    assert.equal(ok([{ on: 's', method: 'quiet', args: [] }, throwsStep('sync')]).rejected.length, 0);
    const none = ok([{ on: 's', method: 'quiet', args: [] }]);
    assert.equal(none.accepted.length, 0);
    assert.match(none.rejected[0].reason, /at least one step must expect a value or a throw/);
  });
  test('old content is unchanged: same version and the same check-set hash when no step uses throws', () => {
    const honest = JSON.parse(HONEST);
    const r = registry().validateChecks(honest.checks, honest.acceptance_criteria);
    assert.equal(r.version, 'qb-checks/2');
    assert.deepEqual(r.accepted, honest.checks);
    assert.equal(registry().checkSetHash(r.accepted), registry().checkSetHash(honest.checks));
    const t = JSON.parse(THROWS);
    const rt = registry().validateChecks(t.checks, t.acceptance_criteria);
    assert.equal(rt.rejected.length, 0, JSON.stringify(rt.rejected));
    assert.equal(rt.version, 'qb-checks/2.1', 'the new shape is versioned (not qb-checks/3, which is the research route)');
    assert.equal(registry().REGISTRY_VERSION, 'qb-checks/2');
    assert.deepEqual(registry().ADAPTERS, ['module_exports', 'call_returns', 'call_sequence', 'call_throws'], 'no new adapter');
  });
});

describe('10694: the real runner — only the invoked method\'s own throw counts', () => {
  const run = (checks) => runIn({ 'lib/thing.js': THING }, checks).byId;
  test('a synchronous throw and an awaited rejection with the expected fragment pass', () => {
    const r = run([seq('A', [throwsStep('sync')]), seq('B', [throwsStep('rejects')])]);
    assert.equal(r.A.status, 'pass', r.A.detail);
    assert.match(r.A.detail, /step 0: s\.sync\(…\) threw as expected: boom: sync/);
    assert.equal(r.B.status, 'pass', r.B.detail);
  });
  test('the wrong message fails; no throw fails', () => {
    const r = run([seq('W', [throwsStep('wrong')]), seq('Q', [throwsStep('quiet')])]);
    assert.equal(r.W.status, 'fail');
    assert.match(r.W.detail, /threw "something else", expected a message including "boom"/);
    assert.equal(r.Q.status, 'fail');
    assert.match(r.Q.detail, /step 0: s\.quiet\(…\) returned 42 instead of throwing/);
  });
  test('a constructor failure, a missing method, a throwing getter or a missing export never satisfy throws', () => {
    const r = run([
      seq('K', [throwsStep('sync')], { exp: 'Broken' }),
      seq('M', [throwsStep('nope')]),
      seq('G', [throwsStep('trap')]),
      seq('X', [throwsStep('sync')], { exp: 'missing' }),
      seq('N', [throwsStep('sync')], { exp: 'notAClass' }),
      seq('F', [throwsStep('sync')], { module: 'lib/absent.js' }),
    ]);
    assert.equal(r.K.status, 'fail'); assert.match(r.K.detail, /creating instance s threw: boom: constructor/);
    assert.equal(r.M.status, 'fail'); assert.match(r.M.detail, /step 0: s\.nope is not a function/);
    assert.notEqual(r.G.status, 'pass', r.G.detail);
    assert.equal(r.X.status, 'fail'); assert.equal(r.N.status, 'fail');
    assert.equal(r.F.status, 'error');
  });
  test('a timeout and a process exit are errors, never a pass', () => {
    const r = runIn({ 'lib/thing.js': THING }, [seq('H', [throwsStep('hang')]), seq('E', [throwsStep('bye')])], { timeoutMs: 1500 }).byId;
    assert.equal(r.H.status, 'error'); assert.match(r.H.detail, /timed out/);
    assert.equal(r.E.status, 'error'); assert.match(r.E.detail, /no result/);
  });
  test('a throw expected at step 1 is not satisfied by an earlier step throwing', () => {
    const r = run([seq('S', [{ on: 's', method: 'sync', args: [] }, throwsStep('quiet')])]);
    assert.equal(r.S.status, 'fail');
    assert.match(r.S.detail, /step 0: s\.sync\(…\) threw/);
  });
  test('the runner declares the capability in its results', () => {
    const { doc } = runIn({ 'lib/thing.js': THING }, [seq('A', [throwsStep('sync')])]);
    assert.equal(doc.format, 'qb-check-results/1');
    assert.deepEqual(doc.capabilities, ['call_sequence.throws']);
  });
});

describe('10694: an old runner\'s results are refused for the new shape, not ignored', () => {
  const { validateCheckResults } = require('../../verify/checks/results');
  const t = JSON.parse(THROWS).checks;
  const resultsOf = (checks, extra = {}) => JSON.stringify({ format: 'qb-check-results/1', check_set_hash: registry().checkSetHash(checks),
    results: checks.map((c) => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter, status: 'pass', detail: 'x' })), complete: true, ...extra });
  test('results without the capability are unusable when a step uses throws', () => {
    const v = validateCheckResults(resultsOf(t), t, registry().checkSetHash(t));
    assert.deepEqual(v, { ok: false, reason: 'check_runner_lacks_throws' });
    assert.equal(validateCheckResults(resultsOf(t, { capabilities: ['call_sequence.throws'] }), t, registry().checkSetHash(t)).ok, true);
  });
  test('old checks with old results stay valid', () => {
    const h = JSON.parse(HONEST).checks;
    assert.equal(validateCheckResults(resultsOf(h), h, registry().checkSetHash(h)).ok, true);
  });
});

describe('10694: the actual API checks on the pinned source (07d7196) and its synthetic guard-removed mutation', () => {
  const checks = JSON.parse(THROWS).checks;
  test('the fragment is grounded in the pinned source\'s number-conversion error', () => {
    assert.ok(PINNED.includes(`cannot be converted to a number.`));
    for (const id of ['CHK-1', 'CHK-2']) {
      const c = checks.find((k) => k.id === id);
      assert.equal(c.params.steps[0].method, 'asNumber');
      assert.deepEqual(c.params.steps[0].throws, { message_includes: FRAGMENT });
    }
  });
  test('the synthetic mutation (guard removed) FAILS the empty/whitespace criteria; the pinned source PASSES them; both keep the string results', () => {
    const fixed = pinned(checks).byId;
    const base = pinned(checks, { base: true }).byId;
    for (const id of ['CHK-1', 'CHK-2']) {
      assert.equal(fixed[id].status, 'pass', `pinned ${id}: ${fixed[id].detail}`);
      assert.equal(base[id].status, 'fail', `mutation ${id}: ${base[id].detail}`);
      assert.match(base[id].detail, /returned '0' instead of throwing/);
    }
    for (const id of ['CHK-3', 'CHK-4', 'CHK-5']) {
      assert.equal(fixed[id].status, 'pass', id); assert.equal(base[id].status, 'pass', id);
    }
  });
  test('a constructor TypeError is not success: throws on the class itself without new is not expressible as a passing method throw', () => {
    const ctor = [{ id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_sequence', params: { module: 'lib/serializer.js', export: 'default',
      instances: { s: { construct: 'call', args: [] } }, steps: [{ on: 's', method: 'asNumber', args: [''], throws: { message_includes: FRAGMENT } }] } }];
    const r = pinned(ctor).byId['CHK-1'];
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /creating instance s threw: Class constructor Serializer cannot be invoked without 'new'/);
  });
  test('every criterion\'s evidence path through verify(): AC-1/AC-2 decided by their checks; adds_tests stays human review; not an overall PASS', async () => {
    const contract = state().approve(contractOf(THROWS), { via: 'test' });
    assert.equal(contract.checks_registry, 'qb-checks/2.1');
    const L = (o) => JSON.stringify(o) + '\n';
    const report = L({ type: 'qb:start', format: 'qb-node-test-events/1' })
      + ['empty string throws', 'whitespace throws'].map((name) => L({ type: 'test:pass', name, nesting: 0, path: [], file: '/verify/test/asNumber.test.js', kind: 'test', skip: false, todo: false, failureType: null })).join('')
      + L({ type: 'test:summary', file: null, counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, success: true }) + L({ type: 'qb:end' });
    const diff = 'diff --git a/test/asNumber.test.js b/test/asNumber.test.js\n--- a/test/asNumber.test.js\n+++ b/test/asNumber.test.js\n@@ -1 +1,3 @@\n'
      + "+test('empty string throws', () => { assert.throws(() => new Serializer().asNumber('')) })\n+test('whitespace throws', () => { assert.throws(() => new Serializer().asNumber('  ')) })\n";
    const verifyWith = async (text) => {
      const execution = { id: 'e', status: 'completed', diff, candidate_tree: TREE,
        changes: [{ file: 'lib/serializer.js', status: 'M' }, { file: 'test/asNumber.test.js', status: 'M' }],
        sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report, tree: TREE },
          checks: { tree: TREE, check_set_hash: registry().checkSetHash(contract.checks), results_text: text } } };
      const v = await require('../../verify/verifier').verify(contract, null, execution, { noLlm: true });
      return { v, by: Object.fromEntries(v.criteria_results.map((c) => [c.id, c])) };
    };
    const good = await verifyWith(pinned(contract.checks).text);
    for (const id of ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']) assert.deepEqual([good.by[id].met, good.by[id].method], [true, 'check'], `${id}: ${good.by[id].evidence}`);
    assert.equal(good.by['AC-6'].met, null);
    assert.equal(good.by['AC-6'].human_review, true);
    assert.notEqual(good.v.verdict, 'pass', 'adds_tests is advisory/human review: not an overall PASS');
    const bad = await verifyWith(pinned(contract.checks, { base: true }).text);
    for (const id of ['AC-1', 'AC-2']) assert.equal(bad.by[id].met, false, `${id}: ${bad.by[id].evidence}`);
    for (const id of ['AC-3', 'AC-4', 'AC-5']) assert.equal(bad.by[id].met, true, id);
    assert.equal(bad.v.verdict, 'fail');
  });
});

describe('10694: check-fidelity cautions for error criteria', () => {
  test('the throws fixture passes full validation', () => {
    assert.deepEqual(errorsOf(THROWS), []);
  });
  test('an existence-only module_exports check cannot stand in for "asNumber throws"', () => {
    const e = errorsOf(THROWS, (d) => { d.checks[0] = { id: 'CHK-1', ac_id: 'AC-1', adapter: 'module_exports', params: { module: 'lib/serializer.js', export: 'default', type: 'function' } }; }).join('\n');
    assert.match(e, /CHK-1 \(AC-1\) only checks that lib\/serializer\.js exports default exists, but AC-1 is about behaviour \(Serializer\.asNumber\(\)\): an existence check cannot verify it/);
  });
  test('a genuine export-existence criterion may still use module_exports', () => {
    const e = errorsOf(THROWS, (d) => {
      d.acceptance_criteria.push({ id: 'AC-7', criterion: 'lib/serializer.js still exports the Serializer class.', met: null, kind: 'behavioral', requirement_ids: ['R-1'] });
      d.checks.push({ id: 'CHK-7', ac_id: 'AC-7', adapter: 'module_exports', params: { module: 'lib/serializer.js', export: 'default', type: 'function' } });
    });
    assert.deepEqual(e, []);
  });
  test('an error criterion bound only to value expectations is rejected: it must assert the throw', () => {
    const e = errorsOf(THROWS, (d) => { d.checks[0].params.steps[0] = { on: 's', method: 'asNumber', args: [''], expect: '0' }; }).join('\n');
    assert.match(e, /CHK-1 \(AC-1\) never asserts a throw, but AC-1 says asNumber throws: use a call_sequence step with throws \(or call_throws on the function itself\)/);
  });
});

describe('10694: prompt, docs and fixture labels', () => {
  test('the L1 prompt documents throws on call_sequence steps, mutually exclusive with expect', () => {
    const sys = fs.readFileSync(path.join(ROOT, 'intent', 'prompts', 'system.md'), 'utf8');
    assert.match(sys, /"throws": \{ "message_includes": "/);
    assert.match(sys, /never both `expect` and `throws`/);
  });
  test('FIXTURES.md labels the source and the synthetic mutation', () => {
    const idx = read('FIXTURES.md');
    assert.match(idx, /`pinned-api-throws\.json` \| \*\*human-reviewed, faithful to the pinned repository\*\*/);
    assert.match(idx, /SYNTHETIC mutation/);
    assert.match(idx, /07d7196/);
    assert.match(read('pinned-fast-json-stringify/README.md'), /SYNTHETIC mutation, not necessarily the owner's original repository base/);
  });
});
