/**
 * KAN-106, owner priority (after 10733 / 10734): option B, the STRUCTURED (STAGED) L1 compiler, as a
 * bounded OFFLINE prototype behind its own explicit profile (--l1-profile qwen-14b-staged). The default
 * path and the qwen-14b-experimental profile are unchanged.
 *
 *   - QB derives one requirement per request passage (intent/passages.js), deterministically;
 *   - a location-only passage ("In lib/x.js,") is `context`, deterministically and conservatively;
 *   - a requested-tests passage (intent/request-targets.js add_tests) is an adds_tests criterion with no
 *     check: unresolved for human review;
 *   - for every other requirement the model fills ONE small schema-constrained JSON (cases: requirement,
 *     call, args, outcome, expected, error_fragment), sent as Ollama's JSON-schema `format`; every reply
 *     is validated against that schema by QB and repaired at most once per call;
 *   - QB assembles ids, links, adapter shape (call_sequence + construct:new from the static API
 *     grounding), constraint_policy and the adds_tests criterion; error fragments are PICKED by number
 *     from literal pieces QB extracts from the grounded excerpt, never typed by the model.
 * The output must pass the EXISTING validators unchanged.
 *
 * No model calls: the model is faked (test/helpers/mocks.js). The fake replies below are labelled as
 * the fake model's facts; the request, source and controls are the existing KAN-106 fixtures.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const REQUEST = read('request.txt').trim();
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const BASE = PINNED.replace(GUARD, '');
const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
const STAGED_PROMPT = path.join(__dirname, '..', '..', 'intent', 'prompts', 'staged-facts.md');
const PROFILE = 'qwen-14b-staged';

const staged = () => require('../../intent/staged');
const { contractState } = require('../../intent/contract-state');
const { apiGroundingErrors } = require('../../intent/api-grounding');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-staged-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const repoFiles = (src) => ({ 'package.json': '{"name":"pinned","type":"commonjs"}', 'lib/serializer.js': src, 'test/asNumber.test.js': "'use strict'\n" });

/** What the fake model was asked: the requirement id (from the schema enum) and the prompt text. */
function asked(init) {
  const body = JSON.parse(init.body);
  const schema = body.format;
  const rid = schema && schema.properties && schema.properties.cases.items.properties.requirement.enum[0];
  const user = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  return { body, schema, rid, user };
}
/** The fragment number the prompt lists for a piece containing `text` (the fake reads the list it was shown). */
function fragmentNo(user, text) {
  const m = [...user.matchAll(/^(\d+): (".*")$/gm)].find((x) => JSON.parse(x[2]).includes(text));
  return m ? Number(m[1]) : null;
}
const CALL = 'Serializer.asNumber (lib/serializer.js)';
/** FAKE MODEL facts for the fixture request (what a correct model would state per requirement). */
const FAKE_FACTS = {
  'R-2': (u) => ({ cases: [
    { requirement: 'R-2', call: CALL, args: [''], outcome: 'throws', expected: null, error_fragment: fragmentNo(u, 'cannot be converted') },
    { requirement: 'R-2', call: CALL, args: ['   '], outcome: 'throws', expected: null, error_fragment: fragmentNo(u, 'cannot be converted') },
  ] }),
  'R-3': () => ({ cases: [{ requirement: 'R-3', call: CALL, args: [0], outcome: 'returns', expected: '0', error_fragment: null }] }),
  'R-4': () => ({ cases: [{ requirement: 'R-4', call: CALL, args: ['0'], outcome: 'returns', expected: '0', error_fragment: null }] }),
  'R-5': () => ({ cases: [{ requirement: 'R-5', call: CALL, args: ['12.5'], outcome: 'returns', expected: '12.5', error_fragment: null }] }),
};

/**
 * Run the real producer (compileIntent) with the staged profile and a faked model.
 * `script(rid, attempt, user)` may return a raw string to reply instead of the fake facts.
 */
async function produce({ request = REQUEST, files = repoFiles(BASE), facts = FAKE_FACTS, script = null, now = null, l1Budget = null } = {}) {
  const repo = makeRepo(files);
  const attempts = {};
  const { l1Budget: budgetOf } = require('../../lib/budget');
  const m = mockFetch(async (url, init) => {
    const { rid, user } = asked(init);
    attempts[rid] = (attempts[rid] || 0) + 1;
    const custom = script ? script(rid, attempts[rid], user) : undefined;
    if (custom !== undefined) return ollamaReply(custom);
    return { ...ollamaReply(JSON.stringify(facts[rid](user))), model: 'fake-model', load_duration: 0 };
  });
  try {
    const s = await require('../../intent/session').compileIntent(request, { repoPath: repo.dir, l1Budget: l1Budget || budgetOf({ profile: PROFILE }), ...(now ? { now } : {}) });
    return { s, calls: m.calls, attempts };
  } finally { m.restore(); repo.cleanup(); }
}
/** The REAL check runner against a repository holding the given serializer source (checks unchanged). */
function runChecks(checks, src) {
  const repo = makeRepo(repoFiles(src));
  try {
    const out = path.join(repo.dir, 'results.json');
    const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: repo.dir, checks }), encoding: 'utf8',
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(JSON.parse(fs.readFileSync(out, 'utf8')).results.map((x) => [x.id, x]));
  } finally { repo.cleanup(); }
}

describe('profile: explicit and opt-in; the default and the existing profile are unchanged', () => {
  test('qwen-14b-staged is a known experimental profile: 240 s per call, 420 s for L1, staged', () => {
    const { L1_PROFILES, l1Budget } = require('../../lib/budget');
    assert.ok(L1_PROFILES[PROFILE], 'profile exists');
    assert.equal(L1_PROFILES[PROFILE].staged, true);
    assert.equal(L1_PROFILES[PROFILE].experimental, true);
    assert.deepEqual(l1Budget({ profile: PROFILE }), { ms: 420_000, source: `profile ${PROFILE}`, enforced: true, per_call_ms: 240_000, profile: PROFILE });
    const { validateRunOptions } = require('../../lib/run-options');
    assert.deepEqual(validateRunOptions({ agent: 'dry-run', repo: os.tmpdir(), maxRetries: '3', l1Profile: PROFILE }, 'x').errors, []);
  });
  test('without the staged profile, L1 is the single-draft compiler: no JSON-schema format is sent (default and qwen-14b-experimental)', async () => {
    const { l1Budget } = require('../../lib/budget');
    for (const budget of [null, l1Budget({ profile: 'qwen-14b-experimental' })]) {
      const repo = makeRepo(repoFiles(BASE));
      const m = mockFetch(async () => ollamaReply(read('e578f99b-hand-corrected-diagnostic.json')));
      try {
        const s = await require('../../intent/session').compileIntent(REQUEST, { repoPath: repo.dir, ...(budget ? { l1Budget: budget } : {}) });
        assert.equal(m.calls.length, 1);
        assert.equal(JSON.parse(m.calls[0].init.body).format, undefined);
        assert.equal(s.staged, undefined);
      } finally { m.restore(); repo.cleanup(); }
    }
  });
});

describe('deterministic parts', () => {
  test('literal pieces: a template literal is split at ${…} and only its literal pieces are kept (never stitched)', () => {
    const { literalPieces } = staged();
    const src = 'asNumber (i) {\n  if (x) {\n    throw new Error(`The value "${i}" cannot be converted to a number.`)\n  }\n  return "" + i\n}';
    assert.deepEqual(literalPieces(src), ['The value', 'cannot be converted to a number.']);
    assert.ok(!literalPieces(src).some((p) => /The value.*cannot/.test(p)));
  });
  test('literal pieces: string concatenation in a throw; strings outside a throw and computed messages give none', () => {
    const { literalPieces } = staged();
    assert.deepEqual(literalPieces("f (x) { throw new TypeError('expected ' + typeof x + ' to be a string') }"), ['expected', 'to be a string']);
    assert.deepEqual(literalPieces("f (x) { const m = 'not an error message'; return m }"), []);
    assert.deepEqual(literalPieces('f (x) { throw new Error(format("bad %s", x)) }'), [], 'a call inside the message: not a literal message');
    assert.deepEqual(literalPieces('f (x) { throw err }'), []);
    assert.deepEqual(literalPieces('f (x) { throw new Error(`${x}`) }'), []);
    assert.deepEqual(literalPieces('this is not `closed'), [], 'untokenizable text gives none');
  });
  test('a location-only passage is context only when its text is exactly a path locator (conservative)', () => {
    const { isLocationOnly } = staged();
    for (const yes of ['In lib/serializer.js,', 'In `lib/serializer.js`,', 'in src/a/b.mjs,', 'In lib/serializer.js']) assert.equal(isLocationOnly(yes), true, yes);
    for (const no of ['In lib/a.js and lib/b.js,', 'In lib/a.js do not change anything,', 'In this case,', 'In the serializer,', 'lib/a.js,',
      'In lib/a.js, make it fast.', 'Update lib/a.js,', 'In lib/a.js only,', 'In lib/../a.js,', 'In /etc/a.js,']) assert.equal(isLocationOnly(no), false, no);
  });
  test('kept passages: every passage of a sentence that starts with Keep / Preserve; the change passage is not kept', () => {
    const { passageRoles } = staged();
    const roles = Object.fromEntries(passageRoles(REQUEST).map((r) => [r.passage_id, r.role]));
    assert.deepEqual(roles, { P1: 'context', P2: 'change', P3: 'keep', P4: 'keep', P5: 'keep', P6: 'adds_tests' });
  });
  test('the staged system prompt is generic: no task values', () => {
    const text = fs.readFileSync(STAGED_PROMPT, 'utf8');
    assert.doesNotMatch(text, /asNumber|Serializer|cannot be converted|serializer\.js|12\.5/);
  });
});

describe('the fixture request (asNumber, KAN-106), produced with the staged profile and a faked model', () => {
  test('the producer finalizes; the EXISTING validator independently agrees', async () => {
    const { s } = await produce();
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.deepEqual(contractState(s.contract), { state: 'finalized' });
    assert.deepEqual(apiGroundingErrors(s.contract), []);
    assert.equal(s.contract.checks_rejected.length, 0);
  });
  test('assembly: one requirement per passage; R-1 context; one criterion and one check per case; requested tests adds_tests with no check', async () => {
    const { s } = await produce();
    const c = s.contract;
    assert.deepEqual(c.requirements.map((r) => [r.id, r.passage_ids, r.disposition || null]),
      [['R-1', ['P1'], 'context'], ['R-2', ['P2'], null], ['R-3', ['P3'], null], ['R-4', ['P4'], null], ['R-5', ['P5'], null], ['R-6', ['P6'], null]]);
    assert.deepEqual(c.acceptance_criteria.map((a) => [a.id, a.requirement_ids]),
      [['AC-1', ['R-2']], ['AC-2', ['R-2']], ['AC-3', ['R-3']], ['AC-4', ['R-4']], ['AC-5', ['R-5']], ['AC-6', ['R-6']]]);
    assert.deepEqual(c.acceptance_criteria[5].adds_tests, { files: ['test/asNumber.test.js'] });
    assert.equal(c.checks.filter((k) => k.ac_id === 'AC-6').length, 0, 'requested tests: decided from the test run, unresolved for review');
    for (const ac of c.acceptance_criteria.slice(0, 5)) assert.equal(c.checks.filter((k) => k.ac_id === ac.id).length, 1, ac.id);
    for (const k of c.checks) {
      assert.equal(k.adapter, 'call_sequence');
      assert.equal(k.params.module, 'lib/serializer.js');
      assert.equal(k.params.export, 'default');
      assert.deepEqual(k.params.instances, { s: { construct: 'new', args: [] } });
      assert.equal(k.params.steps.length, 1);
      assert.equal(k.params.steps[0].method, 'asNumber');
      assert.equal(k.id, k.ac_id.replace('AC-', 'CHK-'));
    }
    assert.deepEqual(c.scope, { allowed_changes: ['lib/serializer.js', 'test/asNumber.test.js'], protected_paths: [] });
  });
  test('kept behaviours: each is a constraint enforced by the check that exercises that same input', async () => {
    const { s } = await produce();
    const c = s.contract;
    assert.equal(c.constraints.length, 3);
    const byId = Object.fromEntries(c.checks.map((k) => [k.id, k]));
    const ac = Object.fromEntries(c.acceptance_criteria.map((a) => [a.id, a]));
    const want = [[0, 'R-3', 0], [1, 'R-4', '0'], [2, 'R-5', '12.5']];
    for (const [i, rid, arg] of want) {
      const e = c.constraint_policy.find((p) => p.constraint === i);
      assert.equal(e.enforced_by.length, 1);
      const k = byId[e.enforced_by[0].ref];
      assert.deepEqual(k.params.steps[0].args, [arg], `constraint ${i}`);
      assert.deepEqual(ac[k.ac_id].requirement_ids, [rid]);
      assert.ok(k.params.steps[0].expect !== undefined, 'a kept behaviour is a value check, not a throw');
    }
  });
  test('the error fragment is one of the literal pieces QB extracted from the grounded excerpt, picked by number', async () => {
    const { s, calls } = await produce();
    const fr = s.staged.fragments.find((f) => f.call === CALL);
    assert.deepEqual(fr.pieces, ['The value', 'cannot be converted to a number.']);
    const throws = s.contract.checks.filter((k) => k.params.steps[0].throws);
    assert.equal(throws.length, 2);
    for (const k of throws) assert.equal(k.params.steps[0].throws.message_includes, 'cannot be converted to a number.');
    const r2 = calls.map((x) => asked(x.init)).find((x) => x.rid === 'R-2');
    assert.deepEqual(r2.schema.properties.cases.items.properties.error_fragment.anyOf, [{ type: 'integer', enum: [0, 1] }, { type: 'null' }]);
    assert.match(r2.user, /^1: "cannot be converted to a number\."$/m);
  });
  test('REAL check runner, generated checks unchanged: the throw checks fail on the guard-removed base and pass on the pinned correct source; kept checks pass on both', async () => {
    const { s } = await produce();
    const checks = s.contract.checks;
    const fixed = runChecks(checks, PINNED);
    for (const k of checks) assert.equal(fixed[k.id].status, 'pass', `${k.id} on correct code: ${fixed[k.id].detail}`);
    const base = runChecks(checks, BASE);
    for (const id of ['CHK-1', 'CHK-2']) assert.equal(base[id].status, 'fail', `${id} on base: ${base[id].detail}`);
    for (const id of ['CHK-3', 'CHK-4', 'CHK-5']) assert.equal(base[id].status, 'pass', `${id} on base: ${base[id].detail}`);
  });
  test('one small call per behavioural requirement, each with a strict JSON-schema format; no call for context or requested tests', async () => {
    const { calls } = await produce();
    const seen = calls.map((x) => asked(x.init));
    assert.deepEqual(seen.map((x) => x.rid), ['R-2', 'R-3', 'R-4', 'R-5']);
    for (const x of seen) {
      assert.equal(x.body.stream, false);
      assert.equal(x.schema.type, 'object');
      assert.equal(x.schema.additionalProperties, false);
      assert.deepEqual(x.schema.properties.cases.items.properties.call.enum, [CALL]);
      assert.equal(x.schema.properties.cases.items.additionalProperties, false);
    }
  });
});

describe('bad model JSON is refused and repaired at most once per call', () => {
  test('not JSON, then valid: refused, one repair, finalized', async () => {
    const { s, attempts } = await produce({ script: (rid, n) => (rid === 'R-3' && n === 1 ? '{"cases": [ {"requirement": "R-3", ' : undefined) });
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.equal(attempts['R-3'], 2);
    const f = s.staged.facts.find((x) => x.requirement_id === 'R-3');
    assert.equal(f.attempts.length, 2);
    assert.match(f.attempts[0].errors[0], /not valid JSON/);
    assert.deepEqual(f.attempts[1].errors, []);
  });
  test('schema violations are refused: an unknown key, a wrong requirement id, a call not listed, an expected value on a throw, an out-of-range fragment', () => {
    const { factSchema, validateFacts } = staged();
    const schema = factSchema({ requirementId: 'R-3', calls: [CALL], fragments: 2 });
    const ok = { requirement: 'R-3', call: CALL, args: [0], outcome: 'returns', expected: '0', error_fragment: null };
    assert.deepEqual(validateFacts(schema, { cases: [ok] }), []);
    const bad = [
      { cases: [{ ...ok, construct: 'new' }] },
      { cases: [{ ...ok, requirement: 'R-4' }] },
      { cases: [{ ...ok, call: 'asNumber' }] },
      { cases: [{ ...ok, outcome: 'throws', expected: '0', error_fragment: 1 }] },
      { cases: [{ ...ok, outcome: 'throws', expected: null, error_fragment: 7 }] },
      { cases: [{ ...ok, error_fragment: 0 }] },
      { cases: [ok, ok] },
      { cases: [ok], extra: true },
      [],
    ];
    for (const b of bad) assert.ok(validateFacts(schema, b).length > 0, JSON.stringify(b));
  });
  test('invalid twice: the call is not repaired again, no further call starts, and L1 is invalid with the reasons', async () => {
    const reply = JSON.stringify({ cases: [{ requirement: 'R-3', call: CALL, args: [0], outcome: 'returns', expected: '0', error_fragment: null, construct: 'new' }] });
    const { s, attempts, calls } = await produce({ script: (rid) => (rid === 'R-3' ? reply : undefined) });
    assert.equal(s.state, 'invalid');
    assert.equal(attempts['R-3'], 2);
    assert.equal(attempts['R-4'], undefined, 'no call after the failed requirement');
    assert.equal(calls.length, 3);   // R-2, R-3, R-3 repair
    assert.match(s.errors.join('\n'), /R-3.*refused after one repair/);
    assert.match(s.errors.join('\n'), /construct/);
    assert.equal(s.contract, null);
  });
  test('the repair input names the refusal and asks again with the same schema', async () => {
    const { calls } = await produce({ script: (rid, n) => (rid === 'R-4' && n === 1 ? 'nope' : undefined) });
    const repairs = calls.map((x) => asked(x.init)).filter((x) => x.rid === 'R-4');
    assert.equal(repairs.length, 2);
    assert.deepEqual(repairs[1].schema, repairs[0].schema);
    assert.match(repairs[1].body.messages.at(-1).content, /QB refused your reply/);
    assert.equal(repairs[1].body.messages.at(-2).role, 'assistant');
  });
});

describe('a requested new export or new file is not falsely refused', () => {
  test('a new function exported from an existing module (absent from its grounded exports)', async () => {
    const request = 'In lib/math.js, export a new function clamp(x, lo, hi) that returns lo when x is below lo.';
    const facts = { 'R-2': () => ({ cases: [{ requirement: 'R-2', call: 'clamp (lib/math.js)', args: [-5, 0, 10], outcome: 'returns', expected: 0, error_fragment: null }] }) };
    const { s } = await produce({ request, facts, files: { 'package.json': '{"name":"m"}', 'lib/math.js': 'function sum (a, b) { return a + b }\nmodule.exports = { sum }\n' } });
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.deepEqual(contractState(s.contract), { state: 'finalized' });
    const k = s.contract.checks[0];
    assert.deepEqual([k.adapter, k.params.module, k.params.export, k.params.args, k.params.expect], ['call_returns', 'lib/math.js', 'clamp', [-5, 0, 10], 0]);
  });
  test('a new file the request creates (no source to ground): a function check, not a refusal', async () => {
    const request = 'Create lib/slug.js exporting slugify(text) that returns the text in lower case.';
    const facts = { 'R-1': () => ({ cases: [{ requirement: 'R-1', call: 'slugify (lib/slug.js)', args: ['Hello'], outcome: 'returns', expected: 'hello', error_fragment: null }] }) };
    const { s, calls } = await produce({ request, facts, files: { 'package.json': '{"name":"m"}' } });
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.equal(asked(calls[0].init).schema.properties.cases.items.properties.error_fragment.type, 'null', 'no source, so no fragments to pick');
    const k = s.contract.checks[0];
    assert.deepEqual([k.adapter, k.params.module, k.params.export], ['call_returns', 'lib/slug.js', 'slugify']);
    assert.deepEqual(s.contract.scope.allowed_changes, ['lib/slug.js']);
  });
});

describe('timing is recorded per call, inside the L1 budget', () => {
  test('every fact call and repair is recorded with its requirement, ms, limit and outcome', async () => {
    let clock = 0;
    const now = () => (clock += 1000);
    const { s } = await produce({ now, script: (rid, n) => (rid === 'R-5' && n === 1 ? 'nope' : undefined) });
    const t = s.timings;
    assert.equal(t.schema, 'qb-l1-timings/1');
    assert.deepEqual(t.calls.map((c) => [c.kind, c.requirement_id, c.outcome]),
      [['fact', 'R-2', 'ok'], ['fact', 'R-3', 'ok'], ['fact', 'R-4', 'ok'], ['fact', 'R-5', 'invalid'], ['fact_repair', 'R-5', 'ok']]);
    for (const c of t.calls) { assert.ok(Number.isInteger(c.ms) && c.ms > 0); assert.ok(c.limit_ms > 0 && c.limit_ms <= 240_000, String(c.limit_ms)); }
    assert.equal(t.fact_call_ms.length, 4);
    assert.equal(t.fact_repair_call_ms.length, 1);
    assert.ok(t.l1_ms > 0);
    assert.equal(t.l1_budget.profile, PROFILE);
  });
  test('an exhausted L1 budget stops before the next call; the second call is capped by what is left; the timings travel with the error', async () => {
    let clock = 0;
    const now = () => clock;
    // each faked model call "takes" 250 s on the fake clock (the reply itself is immediate)
    const script = () => { clock += 250_000; return undefined; };
    await assert.rejects(produce({ now, script }), (e) => {
      assert.equal(e.code, 'DEADLINE');
      assert.equal(e.kind, 'l1');
      assert.match(e.message, /exhausted before the fact call for R-4/);
      assert.deepEqual(e.l1_timings.calls.map((c) => [c.requirement_id, c.ms, c.limit_ms]), [['R-2', 250_000, 240_000], ['R-3', 250_000, 170_000]]);
      return true;
    });
  });
});
