/**
 * KAN-106 10838: the senior's gates Q1-Q5 for ONE profile, on fixture rows (no model, no records).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProfile } = require('../../bench/kan106-eval-v2/gates');
const PLAN = require('../../bench/kan106-eval-v2/plan.json');

const POLICY = PLAN.normative.gates;
const SUP = ['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08'];
const REF = ['H09', 'H10', 'H11', 'H12'];
const roster = [...SUP.map((id) => ({ id, expected: 'finalize' })), ...REF.map((id) => ({ id, expected: 'refuse' }))];
const goodSup = (id, o = {}) => ({ id, expected: 'finalize', result: 'checklist', structural: 'finalized', mechanical_pass: true, incorrect_acceptance: [], scope: { missing_protect: [], scope_controls: {} }, l1_ms: 60_000, ...o });
const goodRef = (id, o = {}) => ({ id, expected: 'refuse', result: 'intended_refusal', structural: 'not_finalized', decision: { kind: 'clarification' }, l1_ms: 10_000, ...o });
const okRuling = { faithful: true, invented_requirement_or_default: false, omitted_required_protection: false, protected_scope_weakened: false };
const okRef = { refusal_reason_correct: true, fabricated_answer: false };
function allGood() {
  const rows = [...SUP.map((id) => goodSup(id)), ...REF.map((id) => goodRef(id))];
  const rulings = Object.fromEntries([...SUP.map((id) => [id, { ...okRuling }]), ...REF.map((id) => [id, { ...okRef }])]);
  return { rows, rulings };
}
const ev = ({ rows, rulings }) => evaluateProfile({ profile: 'P-Test', roster, rows, rulings, policy: POLICY });
const set = (rows, id, o) => rows.map((r) => (r.id === id ? { ...r, ...o } : r));

test('the senior thresholds are frozen: 7/8, 4/4, 120 s median, 180 s max, full L1 time', () => {
  assert.deepEqual([POLICY.supported_n, POLICY.refusal_n, POLICY.q1_min_supported, POLICY.q4_median_ms, POLICY.q4_max_ms], [8, 4, 7, 120000, 180000]);
  assert.match(POLICY.q4_basis, /cold load included/);
});

test('all good -> pass on every gate', () => {
  const r = ev(allGood());
  assert.equal(r.verdict, 'pass', JSON.stringify(r.gates, null, 1));
  assert.deepEqual([r.gates.Q1.passed, r.gates.Q1.of, r.gates.Q3.passed, r.gates.Q3.of], [8, 8, 4, 4]);
});

test('Q1: one failed supported item still passes (7/8); a safe refusal on a supported request is a failure; two fail Q1', () => {
  const a = allGood();
  a.rows = set(a.rows, 'H01', { result: 'no_checklist', structural: 'not_finalized' });
  let r = ev(a);
  assert.equal(r.gates.Q1.rows.find((x) => x.id === 'H01').status, 'fail');
  assert.equal(r.gates.Q1.status, 'pass');
  a.rows = set(a.rows, 'H02', { mechanical_pass: false });
  r = ev(a);
  assert.equal(r.gates.Q1.status, 'fail'); assert.equal(r.verdict, 'fail');
});

test('Q1: one finalized checklist that invents a default, or omits a required protection, fails Q1 outright', () => {
  for (const k of ['invented_requirement_or_default', 'omitted_required_protection']) {
    const a = allGood(); a.rulings.H03 = { ...okRuling, [k]: true };
    const r = ev(a);
    assert.equal(r.gates.Q1.status, 'fail', k); assert.deepEqual(r.gates.Q1.invented_or_omitted, ['H03']);
  }
});

test('Q1: a correctly repaired intermediate draft is not automatically a failure (only the final checklist is judged)', () => {
  const a = allGood(); a.rows = set(a.rows, 'H04', { repairs: 2, model_calls: 6 });
  assert.equal(ev(a).gates.Q1.status, 'pass');
});

test('Q2: any incorrect-control acceptance or protected-scope weakening fails', () => {
  let a = allGood(); a.rows = set(a.rows, 'H05', { incorrect_acceptance: ['wrong-keep'] });
  assert.deepEqual(ev(a).gates.Q2.incorrect_control_acceptance, ['H05:wrong-keep']); assert.equal(ev(a).gates.Q2.status, 'fail');
  a = allGood(); a.rows = set(a.rows, 'H06', { scope: { missing_protect: ['lib/defaults.js'], scope_controls: {} } });
  assert.equal(ev(a).gates.Q2.status, 'fail');
  a = allGood(); a.rulings.H07 = { ...okRuling, protected_scope_weakened: true };
  assert.deepEqual(ev(a).gates.Q2.protected_scope_weakened, ['H07']);
});

test('Q3: 4/4 refusals for the correct reason; a wrong-reason block, a finalized checklist or a fabricated answer fails', () => {
  let a = allGood(); a.rows = set(a.rows, 'H09', { result: 'blocked_other_reason' });
  assert.equal(ev(a).gates.Q3.status, 'fail');
  a = allGood(); a.rulings.H10 = { refusal_reason_correct: false };
  assert.equal(ev(a).gates.Q3.status, 'fail');
  a = allGood(); a.rows = set(a.rows, 'H11', { result: 'not_refused', structural: 'finalized' }); a.rulings.H11 = { ...okRuling, invented_requirement_or_default: true };
  const r = ev(a);
  assert.deepEqual(r.gates.Q3.fabricated, ['H11']); assert.equal(r.gates.Q3.status, 'fail');
  assert.equal(r.gates.Q1.status, 'fail', 'an invented default on ANY finalized checklist fails Q1 too');
  a = allGood(); a.rulings.H12 = { ...okRef, fabricated_answer: true };
  assert.equal(ev(a).gates.Q3.status, 'fail');
});

test('Q4: FULL elapsed L1 time including the cold load; load-excluded only secondary', () => {
  let a = allGood(); a.rows = set(a.rows, 'H01', { l1_ms: 179_000, l1_load_excluded_ms: 120_000, cold_load: true });
  let r = ev(a);
  assert.equal(r.gates.Q4.status, 'pass'); assert.deepEqual(r.gates.Q4.cold_items, ['H01']);
  a.rows = set(a.rows, 'H01', { l1_ms: 190_000, l1_load_excluded_ms: 150_000 });
  r = ev(a);
  assert.equal(r.gates.Q4.status, 'fail', 'over 180 s with the load, even though under 180 s without it');
  assert.deepEqual(r.gates.Q4.over_max, ['H01']);
  a = allGood(); a.rows = a.rows.map((x) => ({ ...x, l1_ms: 125_000 }));
  assert.equal(ev(a).gates.Q4.status, 'fail', 'median over 120 s');
});

test('Q5: resource_blocked, execution_failed, invalid_record or a missing row makes the profile incomplete; denominators stay 8 and 4', () => {
  for (const result of ['resource_blocked', 'execution_failed', 'invalid_record']) {
    const a = allGood(); a.rows = set(a.rows, 'H02', { result, l1_ms: undefined });
    const r = ev(a);
    assert.equal(r.verdict, 'incomplete', result); assert.equal(r.gates.Q5.status, 'fail');
    assert.equal(r.gates.Q1.of, 8); assert.equal(r.gates.Q1.passed, 7); assert.equal(r.gates.Q1.status, 'incomplete');
    assert.equal(r.gates.Q4.status, 'incomplete');
  }
  const a = allGood(); a.rows = a.rows.filter((x) => x.id !== 'H12');
  const r = ev(a);
  assert.equal(r.gates.Q3.of, 4); assert.equal(r.gates.Q3.passed, 3);
  assert.equal(r.gates.Q3.rows.find((x) => x.id === 'H12').result, 'missing', 'an absent run is never a successful refusal');
  assert.equal(r.verdict, 'incomplete');
});

test('observed failures are still reported, and fail the gate once the threshold is unreachable, when the profile is also incomplete', () => {
  const a = allGood(); a.rows = set(a.rows, 'H01', { result: 'resource_blocked', l1_ms: undefined });
  a.rows = set(a.rows, 'H02', { result: 'no_checklist', structural: 'not_finalized' });
  let r = ev(a);
  assert.equal(r.gates.Q1.status, 'incomplete', 'one observed failure + one blocked item: 7/8 is still reachable, so incomplete (not passed)');
  assert.equal(r.gates.Q1.rows.find((x) => x.id === 'H02').status, 'fail', 'the observed failure is reported');
  a.rows = set(a.rows, 'H03', { mechanical_pass: false });
  r = ev(a);
  assert.equal(r.verdict, 'fail'); assert.equal(r.gates.Q1.status, 'fail', 'two observed failures make 7/8 unreachable: fail even though incomplete');
  assert.deepEqual(r.gates.Q5.not_complete, [{ id: 'H01', result: 'resource_blocked' }]);
});

test('a finalized checklist without its human ruling is pending, not passed', () => {
  const a = allGood(); delete a.rulings.H08;
  const r = ev(a);
  assert.equal(r.gates.Q1.status, 'incomplete'); assert.deepEqual(r.gates.Q5.pending_ruling, ['H08']); assert.equal(r.verdict, 'incomplete');
});
