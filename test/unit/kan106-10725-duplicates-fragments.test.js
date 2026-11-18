/**
 * KAN-106, senior decision 10725 (on smoke report 10722, run e578f99b at QB 31af046: BLOCKED,
 * "AC-4 duplicates AC-3"). The smoke FAILED semantically; this is not an L1 success.
 *
 * (1) The duplicate-criterion rule lowercased and stripped punctuation, so "returns '0' for the input
 *     '0'" and "returns '0' for the input 0" collided: a validator defect. The key is now the exact text
 *     (trimmed only). Exact duplicates are still refused.
 * (2) Prompt: an error built from a template → one contiguous literal fragment, never stitched across an
 *     interpolation; no reliable fragment → do not invent one.
 * (3) Prompt: each input value stays tied to its OWN requirement id; requested kept behaviours get a
 *     check whenever an adapter can express them.
 * (4) Replay of the exact generated failure (e578f99b-draft2.json) through the real producer and the
 *     real check runner, on the pinned serializer (correct code) and its guard-removed base: the
 *     duplicate false positive is gone, but the ORIGINAL message fragment still FAILS on correct code.
 *     A separately labelled HAND-CORRECTED DIAGNOSTIC (never model output, never a model recovery)
 *     shows the right fragment, a numeric-string check and the right mappings.
 * No model calls: the model is faked.
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
const DRAFT1 = read('e578f99b-draft1.json');
const DRAFT2 = read('e578f99b-draft2.json');
const RECORDED = JSON.parse(read('e578f99b-errors.json'));
const HAND = read('e578f99b-hand-corrected-diagnostic.json');
const THROWS = read('pinned-api-throws.json');
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const BASE = PINNED.replace(GUARD, '');
const SYSTEM = fs.readFileSync(path.join(__dirname, '..', '..', 'intent', 'prompts', 'system.md'), 'utf8');
const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');

const { validateTraceability } = require('../../intent/requirements');
const { contractState } = require('../../intent/contract-state');
const { contractFromObject } = require('../../intent/compiler');
const { resolveInRequest } = require('../../intent/passages');

function contractOf(text, request = REQUEST) {
  const raw = JSON.parse(text);
  raw.requirements = raw.requirements.map((r) => (r.passage_ids ? { ...r, quote: resolveInRequest(request, r.passage_ids).text } : r));
  return contractFromObject(raw, request);
}
const dupErrors = (c) => validateTraceability(c).errors.filter((e) => /duplicates/.test(e));
/** The honest pinned contract plus two extra criteria on R-3 with the given texts. */
function withPair(a, b) {
  const c = contractOf(THROWS);
  c.acceptance_criteria.push({ id: 'AC-8', criterion: a, met: null, kind: 'behavioral', requirement_ids: ['R-3'] },
    { id: 'AC-9', criterion: b, met: null, kind: 'behavioral', requirement_ids: ['R-3'] });
  return c;
}

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-10725-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const repoFiles = (src) => ({ 'package.json': '{"name":"pinned","type":"commonjs"}', 'lib/serializer.js': src, 'test/asNumber.test.js': "'use strict'\n" });
async function produce(replies, src = BASE) {
  const repo = makeRepo(repoFiles(src));
  let i = 0;
  const m = mockFetch(async () => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try { return { s: await require('../../intent/session').compileIntent(REQUEST, { repoPath: repo.dir }), calls: m.calls.length }; }
  finally { m.restore(); repo.cleanup(); }
}
/** The REAL check runner against a repository holding the given serializer source. */
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

describe('10725 (1): the duplicate key is the exact text (trim only)', () => {
  test('0 versus "0" are different criteria (the e578f99b pair)', () => {
    assert.deepEqual(dupErrors(withPair("Serializer.asNumber() returns '0' for the input '0'.", "Serializer.asNumber() returns '0' for the input 0.")), []);
  });
  test('case-sensitive strings are different', () => {
    assert.deepEqual(dupErrors(withPair('format() returns "Null" for a missing value.', 'format() returns "null" for a missing value.')), []);
  });
  test('operators are different', () => {
    assert.deepEqual(dupErrors(withPair('check(x) returns true when x > 0.', 'check(x) returns true when x < 0.')), []);
    assert.deepEqual(dupErrors(withPair('add(a, b) returns a + b.', 'add(a, b) returns a - b.')), []);
  });
  test('meaningful internal whitespace is different', () => {
    assert.deepEqual(dupErrors(withPair('pad() returns "a  b" for the input "a".', 'pad() returns "a b" for the input "a".')), []);
  });
  test('an exact duplicate is still refused, also with surrounding whitespace', () => {
    assert.deepEqual(dupErrors(withPair('pad() returns "a b".', 'pad() returns "a b".')), ['AC-9 duplicates AC-8']);
    assert.deepEqual(dupErrors(withPair('pad() returns "a b".', '  pad() returns "a b".\n')), ['AC-9 duplicates AC-8']);
  });
  test('shared checks are not evidence of duplication: two criteria bound to the same check are not called duplicates', () => {
    const c = withPair('first wording of a behaviour.', 'second wording of a behaviour.');
    c.checks.push({ ...c.checks[2], id: 'CHK-8', ac_id: 'AC-8' }, { ...c.checks[2], id: 'CHK-9', ac_id: 'AC-9' });
    assert.deepEqual(dupErrors(c), []);
  });
});

describe('10725 (2)(3): generic prompt guidance', () => {
  test('an interpolated error message: one contiguous literal fragment, never stitched across an interpolation; none reliable → none invented', () => {
    assert.match(SYSTEM, /one contiguous literal piece/);
    assert.match(SYSTEM, /never join text from both sides of an interpolation/);
    assert.match(SYSTEM, /no reliable fragment[^.]*do not invent one/i);
    assert.doesNotMatch(SYSTEM, /otherwise use only words from the request/, 'request words are not the code\'s message');
  });
  test('each input tied to its own requirement id; kept behaviours get a check whenever an adapter can express them', () => {
    assert.match(SYSTEM, /tied to the requirement that names it/);
    assert.match(SYSTEM, /behaviour the request asks to keep[^.]*needs a check whenever an adapter can express it/);
    assert.match(SYSTEM, /constraint_policy entry names the check that exercises that same behaviour/);
  });
  test('still no task values in the general prompt', () => {
    assert.doesNotMatch(SYSTEM, /asNumber|cannot be converted|Serializer|12\.5/);
  });
});

describe('10725 (4): replay of the exact e578f99b generated failure (observed model output)', () => {
  test('the recorded run: draft 2 failed only on "AC-4 duplicates AC-3"', () => {
    assert.deepEqual(RECORDED.draft2_errors, ['AC-4 duplicates AC-3']);
    assert.deepEqual(RECORDED.draft2_later_errors, []);
    assert.equal(RECORDED.timings.l1_ms, 341608);
    assert.match(RECORDED.label, /generated failure/);
  });
  test('through the producer (draft 1 → draft 2, model faked): the duplicate false positive is gone; draft 1 keeps its own errors', async () => {
    const { s, calls } = await produce([DRAFT1, DRAFT2]);
    assert.equal(calls, 2);
    for (const e of RECORDED.draft1_errors) assert.ok(s.repair.rejected[0].errors.includes(e), e);
    assert.ok(!s.repair.rejected[0].later_errors.some((e) => /duplicates/.test(e)));
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));   // structurally valid…
  });
  test('…but semantically wrong: the ORIGINAL stitched fragment FAILS on correct code (pinned 07d7196) and on the base', () => {
    const checks = contractOf(DRAFT2).checks;
    const fixed = runChecks(checks, PINNED);
    for (const id of ['CHK-1', 'CHK-2']) {
      assert.equal(fixed[id].status, 'fail', `${id} on correct code: ${fixed[id].detail}`);
      assert.match(fixed[id].detail, /cannot be converted to a number/);
    }
    for (const id of ['CHK-3', 'CHK-4']) assert.equal(fixed[id].status, 'pass', `${id}: ${fixed[id].detail}`);
    const base = runChecks(checks, BASE);
    for (const id of ['CHK-1', 'CHK-2']) assert.equal(base[id].status, 'fail', id);
    for (const id of ['CHK-3', 'CHK-4']) assert.equal(base[id].status, 'pass', id);
  });
  test('the observed draft keeps its other defects: AC-5 has no check, AC-3/AC-4 inputs swapped against R-3/R-4, constraint_policy points at throw checks', () => {
    const c = contractOf(DRAFT2);
    assert.equal(c.checks.filter((k) => k.ac_id === 'AC-5').length, 0);
    const ac = Object.fromEntries(c.acceptance_criteria.map((a) => [a.id, a]));
    const arg = (id) => c.checks.find((k) => k.ac_id === id).params.steps[0].args[0];
    assert.deepEqual([arg('AC-3'), ac['AC-3'].requirement_ids], ['0', ['R-3']]);   // R-3 is "numeric 0"
    assert.deepEqual([arg('AC-4'), ac['AC-4'].requirement_ids], [0, ['R-4']]);     // R-4 is 'string "0"'
    assert.deepEqual(c.constraint_policy.map((p) => p.enforced_by[0].ref), ['CHK-1', 'CHK-2', 'CHK-3']);
  });
});

describe('10725 (4): HAND-CORRECTED DIAGNOSTIC (not model output, not a model recovery)', () => {
  test('it is labelled as such', () => {
    assert.match(JSON.parse(HAND)._label, /^HAND-CORRECTED DIAGNOSTIC .*NOT model output and NOT a model recovery/);
    assert.match(read('FIXTURES.md'), /`e578f99b-hand-corrected-diagnostic\.json` \| \*\*hand-corrected diagnostic\*\*/);
  });
  test('it validates, with each input on its own requirement and a numeric-string check', () => {
    const c = contractOf(HAND);
    assert.equal(contractState(c).state, 'finalized', contractState(c).errors?.join('\n'));
    const arg = (id) => c.checks.find((k) => k.ac_id === id).params.steps[0].args[0];
    const ac = Object.fromEntries(c.acceptance_criteria.map((a) => [a.id, a]));
    assert.deepEqual([arg('AC-3'), ac['AC-3'].requirement_ids], [0, ['R-3']]);
    assert.deepEqual([arg('AC-4'), ac['AC-4'].requirement_ids], ['0', ['R-4']]);
    assert.equal(typeof arg('AC-5'), 'string');
  });
  test('with the real runner: passes on correct code, and the throw checks fail on the base', () => {
    const checks = contractOf(HAND).checks;
    const fixed = runChecks(checks, PINNED);
    for (const id of ['CHK-1', 'CHK-2', 'CHK-3', 'CHK-4', 'CHK-5']) assert.equal(fixed[id].status, 'pass', `${id}: ${fixed[id].detail}`);
    const base = runChecks(checks, BASE);
    for (const id of ['CHK-1', 'CHK-2']) assert.equal(base[id].status, 'fail', id);
    for (const id of ['CHK-3', 'CHK-4', 'CHK-5']) assert.equal(base[id].status, 'pass', id);
  });
});
