/**
 * KAN-106 10749 smoke b7a4bfe2 (staged profile, QB 988d8de, qwen2.5-coder:14b): BLOCKED
 * "staged_l1_invalid: AC-5 duplicates AC-4". Every fact reply was schema-valid on the first attempt.
 * R-5 ("valid numeric strings") repeated the R-4 case "0" → "0", which IS a valid numeric string, so the
 * fact is correct; assemble() made one criterion per case and so produced two identical criteria. That is
 * an ASSEMBLY bug, not a model error.
 *
 * Fix: cases with the identical call, args, outcome and expected value (or fragment) under different
 * requirements become ONE criterion and ONE check citing every requirement; each kept constraint points at
 * the shared check. The same call and args with a different result or outcome is a conflict: refused,
 * never merged.
 *
 * The replay below feeds the UNTOUCHED recorded replies (fixture b7a4bfe2-replies.json, byte for byte)
 * through the fixed assembler with the model faked: "recorded model replies replayed through the fixed
 * assembler". It is NOT a new model run and NOT a generated success of run b7a4bfe2.
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
const RECORDED_TEXT = read('b7a4bfe2-replies.json');
const RECORDED = JSON.parse(RECORDED_TEXT);
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const BASE = PINNED.replace(GUARD, '');
const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
const CALL = 'Serializer.asNumber (lib/serializer.js)';
const { contractState } = require('../../intent/contract-state');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-b7a4-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const repoFiles = (src) => ({ 'package.json': '{"name":"pinned","type":"commonjs"}', 'lib/serializer.js': src, 'test/asNumber.test.js': "'use strict'\n" });
const ridOf = (init) => JSON.parse(init.body).format.properties.cases.items.properties.requirement.enum[0];

/** The producer with the staged profile; the faked model returns `replies[rid]` (a raw string) byte for byte. */
async function produce(replies) {
  const repo = makeRepo(repoFiles(BASE));
  const sent = [];
  const m = mockFetch(async (url, init) => { const rid = ridOf(init); sent.push(rid); return { ...ollamaReply(replies[rid]), model: RECORDED.model }; });
  const { l1Budget } = require('../../lib/budget');
  try { return { s: await require('../../intent/session').compileIntent(REQUEST, { repoPath: repo.dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) }), sent }; }
  finally { m.restore(); repo.cleanup(); }
}
const recordedReplies = () => Object.fromEntries(Object.entries(RECORDED.replies).map(([rid, r]) => [rid, r.raw]));
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
const reply = (rid, cases) => JSON.stringify({ cases: cases.map((c) => ({ requirement: rid, call: CALL, error_fragment: null, ...c })) });

describe('the recorded b7a4bfe2 replies (generated, labelled)', () => {
  test('labelled as generated model replies; no local paths; byte counts match the run record', () => {
    assert.match(RECORDED._label, /^GENERATED MODEL REPLIES/);
    assert.doesNotMatch(RECORDED_TEXT, /\/Users\/|\.qb\/runs|home\//);
    assert.equal(RECORDED.model, 'qwen2.5-coder:14b');
    assert.equal(RECORDED.reason, 'staged_l1_invalid: AC-5 duplicates AC-4');
    assert.equal(RECORDED.timings.l1_ms, 95200);
    assert.deepEqual(RECORDED.timings.calls.map((c) => [c.requirement_id, c.ms]), [['R-2', 38955], ['R-3', 12709], ['R-4', 12476], ['R-5', 30808]]);
    for (const r of Object.values(RECORDED.replies)) { assert.equal(Buffer.byteLength(r.raw), r.raw_bytes); assert.deepEqual(r.errors, []); }
    const r5 = JSON.parse(RECORDED.replies['R-5'].raw).cases.map((c) => c.args[0]);
    assert.deepEqual(r5, ['0', '42', '-42', '3.14', '-3.14']);
  });
});

describe('recorded model replies replayed through the fixed assembler (NOT a new model run)', () => {
  test('finalizes; the EXISTING validator agrees; no duplicate criterion', async () => {
    const { s, sent } = await produce(recordedReplies());
    assert.deepEqual(sent, ['R-2', 'R-3', 'R-4', 'R-5']);
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.deepEqual(contractState(s.contract), { state: 'finalized' });
  });
  test('the shared case "0" → "0" is ONE criterion and ONE check citing R-4 and R-5; both kept constraints point at it', async () => {
    const { s } = await produce(recordedReplies());
    const c = s.contract;
    const zero = c.checks.filter((k) => JSON.stringify(k.params.steps[0].args) === '["0"]');
    assert.equal(zero.length, 1);
    const ac = c.acceptance_criteria.find((a) => a.id === zero[0].ac_id);
    assert.deepEqual(ac.requirement_ids, ['R-4', 'R-5']);
    const pointing = c.constraint_policy.filter((p) => p.enforced_by && p.enforced_by[0].ref === zero[0].id).map((p) => c.constraints[p.constraint]);
    assert.equal(pointing.length, 2);
    assert.ok(pointing.some((t) => /P4/.test(t)) && pointing.some((t) => /P5/.test(t)), pointing.join('\n'));
    assert.equal(c.checks.length, 8);   // "", "   ", 0, "0", "42", "-42", "3.14", "-3.14"
    assert.equal(c.acceptance_criteria.length, 9);   // + the requested-tests criterion
    assert.equal(new Set(c.acceptance_criteria.map((a) => a.criterion)).size, 9);
    for (const k of c.checks) assert.equal(c.acceptance_criteria.filter((a) => a.id === k.ac_id).length, 1);
    assert.equal(c.constraints.length, 6);   // R-3: 1, R-4: 1, R-5: 4
  });
  test('REAL check runner, checks unchanged: the throw checks fail on the guard-removed base and pass on the pinned correct source; every value check passes on both', async () => {
    const { s } = await produce(recordedReplies());
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    const checks = s.contract.checks;
    assert.equal(checks.length, 8);
    const fixed = runChecks(checks, PINNED);
    const base = runChecks(checks, BASE);
    for (const k of checks) {
      assert.equal(fixed[k.id].status, 'pass', `${k.id} on correct code: ${fixed[k.id].detail}`);
      const throws = Boolean(k.params.steps[0].throws);
      assert.equal(base[k.id].status, throws ? 'fail' : 'pass', `${k.id} on base: ${base[k.id].detail}`);
    }
    assert.deepEqual(checks.filter((k) => k.params.steps[0].throws).map((k) => k.params.steps[0].throws.message_includes), ['The value', 'The value']);
  });
});

describe('a same-input conflict across requirements is refused, never merged', () => {
  const base = () => ({
    'R-2': reply('R-2', [{ args: [''], outcome: 'throws', expected: null, error_fragment: 1 }]),
    'R-3': reply('R-3', [{ args: [0], outcome: 'returns', expected: '0' }]),
    'R-4': reply('R-4', [{ args: ['0'], outcome: 'returns', expected: '0' }]),
  });
  test('a different expected value for the same call and args', async () => {
    const { s } = await produce({ ...base(), 'R-5': reply('R-5', [{ args: ['0'], outcome: 'returns', expected: 0 }]) });
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /R-4.*R-5|R-5.*R-4/);
    assert.match(s.errors.join('\n'), /conflict/i);
    assert.equal(s.contract, null);
  });
  test('a different outcome for the same call and args', async () => {
    const { s } = await produce({ ...base(), 'R-5': reply('R-5', [{ args: [''], outcome: 'returns', expected: '0' }]) });
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /R-2.*R-5|R-5.*R-2/);
    assert.match(s.errors.join('\n'), /conflict/i);
  });
  test('a different fragment for the same throwing call', async () => {
    const { s } = await produce({ ...base(), 'R-5': reply('R-5', [{ args: [''], outcome: 'throws', expected: null, error_fragment: 0 }]) });
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /conflict/i);
  });
});
