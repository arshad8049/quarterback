// KAN-114 10689 item 3: why run 44146278864's arm-B record shows raw `verification.verdict: failed` next to QB's final
// PASS, reproduced with the FROZEN v6 logic (verify/research-adapter.js classifyResearchRun, verify/verdict.js) and the
// frozen exception set in bench/opus-pilot/mocha/axios-5892.env.json. No model call; no test names are printed.
//
// Mapping (raw → policy → final):
//   raw research-Mocha channel verdict "failed" (any failing visible test, base failures included)
//   → each failing test is split: frozen exception (exact identity, file, kinds, codes, count; approval bound to base,
//     Node and Mocha) | isolation-qualified (exact signature AND its isolated re-check qualified) | regression (anything else)
//   → no regression + contract test_policy.preexisting_failures "waive" → policy outcome "preexisting_failures"
//     (reason only_frozen_exceptions[+isolation_qualified]); a regression → "failed" (tests_failed)
//   → verdict.js treats passed | preexisting_failures as tests OK; "failed" forces the verdict to fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { classifyResearchRun } = require('../../verify/research-adapter');
const { aggregate } = require('../../verify/verdict');

const ENV = require(path.join(__dirname, '..', '..', 'bench/opus-pilot/mocha/axios-5892.env.json'));
const K = ENV.known_base_failures;

/** a raw channel result whose only failures are exactly the frozen exceptions (+ the one qualified isolation re-check) */
function rawRun({ extra = [], recheck = 'qualified', changeCount = false } = {}) {
  const failing = [
    ...K.entries.map((e, i) => ({ id: e.id, file: e.file, full_title: `redacted-${i}`, kinds: e.kinds, codes: e.codes, failed_count: changeCount && i === 0 ? e.count + 1 : e.count })),
    ...K.isolation_rechecks.map((r, i) => ({ id: r.id, file: r.file, full_title: `redacted-iso-${i}`, kinds: r.signature.kinds, codes: r.signature.codes, failed_count: r.signature.count })),
    ...extra,
  ];
  return { mode: 'research_mocha', status: 'ran', verdict: 'failed', reasons: [], steps: [{ name: 'test', exit_code: 1 }],
    validation: { counts: { total: 151, passed: 151 - failing.length, failed: failing.length }, failing },
    task_base_commit: K.approval.base_commit, probe: { node: K.approval.node, mocha: K.approval.mocha }, known_base_failures: K,
    isolation_rechecks: K.isolation_rechecks.map((r) => ({ id: r.id, verdict: recheck, reasons: [] })) };
}
const finalVerdict = (classified) => aggregate({ hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null, executionStatus: 'completed',
  verification: { status: 'ran', outcome: classified.outcome, outcome_reason: classified.reason }, rules: 6, oracleApproved: true }).verdict;

test('v6 logic: raw "failed" with only frozen exceptions + a qualified isolation re-check → policy preexisting_failures → final PASS', () => {
  const raw = rawRun();
  assert.equal(raw.verdict, 'failed', 'raw channel verdict');
  const c = classifyResearchRun(raw, { preexisting: 'waive' });
  assert.equal(c.outcome, 'preexisting_failures');
  assert.equal(c.reason, 'only_frozen_exceptions+isolation_qualified', 'exactly the reason recorded for run 44146278864 arm B');
  assert.equal(c.regressions.length, 0); assert.equal(c.preexisting.length, K.entries.length); assert.equal(c.isolation_qualified.length, K.isolation_rechecks.length);
  assert.equal(c.trust, 'advisory');
  assert.equal(finalVerdict(c), 'pass');
});

test('negative: an UNWAIVED new failure can never PASS', () => {
  const c = classifyResearchRun(rawRun({ extra: [{ id: 'f'.repeat(64), file: 'test/unit/adapters/http.js', full_title: 'redacted-new', kinds: ['assertion'], codes: ['ERR_ASSERTION'], failed_count: 1 }] }), { preexisting: 'waive' });
  assert.equal(c.outcome, 'failed'); assert.equal(c.reason, 'tests_failed'); assert.equal(c.regressions.length, 1);
  assert.equal(finalVerdict(c), 'fail');
});

test('negative: a changed frozen failure, a non-qualified isolation re-check, or no waiver policy can never PASS', () => {
  for (const [name, raw, policy] of [['changed count', rawRun({ changeCount: true }), 'waive'], ['re-check failed', rawRun({ recheck: 'failed' }), 'waive'], ['policy block', rawRun(), 'block']]) {
    const c = classifyResearchRun(raw, { preexisting: policy });
    assert.equal(c.outcome, 'failed', name);
    assert.notEqual(finalVerdict(c), 'pass', name);
  }
});

test('negative: an approval not bound to this run (base, Node, Mocha) excuses nothing', () => {
  const raw = rawRun(); raw.probe = { ...raw.probe, node: 'v0.0.0' };
  const c = classifyResearchRun(raw, { preexisting: 'waive' });
  assert.equal(c.outcome, 'failed');
  assert.equal(c.regressions.length, K.entries.length + K.isolation_rechecks.length);
});
