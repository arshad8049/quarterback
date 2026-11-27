/**
 * KAN-106 10838: the predeclared gates Q1-Q5, computed for ONE profile (one machine). Pure function; no I/O.
 * Profiles are never pooled: call it once per profile. Denominators are fixed (8 supported, 4 refusal) and come
 * from the frozen roster, never from the rows that happen to exist.
 *
 * Row results (bench/kan106-eval-v1/score.js scoreItem, plus the v2 batch):
 *   complete:   checklist | no_checklist | intended_refusal | blocked_other_reason | not_refused
 *   incomplete: resource_blocked | execution_failed | invalid_record | missing (no row at all)
 * An incomplete row is never a success and never a refusal. A row is scorable only with its human ruling
 * (every finalized checklist and every refusal-item row needs one); without it the row is pending.
 *
 * Ruling fields (semantic-review-ruled.json, the senior's): faithful, invented_requirement_or_default,
 * omitted_required_protection, protected_scope_weakened, refusal_reason_correct, fabricated_answer.
 *
 * Q1  >= q1_min_supported of 8 supported rows: a finalized checklist, mechanically valid, ruled faithful, nothing
 *     invented, no required protection omitted. A safe refusal on a supported request is a failure. Any finalized
 *     checklist (any item) that invents a requirement/default or omits a required protection fails Q1 outright.
 *     Only the FINAL checklist is judged: a bad intermediate draft that was correctly repaired is not a failure.
 * Q2  zero incorrect-control acceptance and zero protected-scope weakening (mechanical or ruled), on any item.
 * Q3  4/4 refusal rows stop for the correct frozen reason (intended_refusal AND ruled correct); a finalized
 *     checklist or a fabricated answer on a refusal item fails Q3.
 * Q4  FULL elapsed L1 time (l1_ms, cold load included): median <= q4_median_ms and every item <= q4_max_ms, over all
 *     12 rows. Load-excluded times are reported as secondary only. The 420 s L1 budget is not the target.
 * Q5  all 12 rows complete and scorable.
 * Status per gate: pass | fail (an OBSERVED failure, reported even when the profile is incomplete) | incomplete.
 * Profile: pass only if Q1-Q5 all pass; fail if any of Q1-Q4 fails; otherwise incomplete.
 */
'use strict';

const COMPLETE = new Set(['checklist', 'no_checklist', 'intended_refusal', 'blocked_other_reason', 'not_refused']);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const finalizedRow = (r) => r.result === 'checklist' || (r.result === 'not_refused' && r.structural === 'finalized');
const needsRuling = (r, expected) => finalizedRow(r) || (expected === 'refuse' && COMPLETE.has(r.result));

function evaluateProfile({ profile, roster, rows, rulings = {}, policy }) {
  const byId = Object.fromEntries((rows || []).map((r) => [r.id, r]));
  const sup = roster.filter((x) => x.expected === 'finalize');
  const ref = roster.filter((x) => x.expected === 'refuse');
  const problems = [];
  if (sup.length !== policy.supported_n || ref.length !== policy.refusal_n) problems.push(`roster has ${sup.length} supported + ${ref.length} refusal, frozen ${policy.supported_n} + ${policy.refusal_n}`);
  for (const r of rows || []) if (!roster.some((x) => x.id === r.id)) problems.push(`row ${r.id} is not in the frozen roster (ignored)`);

  const view = roster.map(({ id, expected }) => {
    const r = byId[id] || { id, result: 'missing' };
    const ruling = rulings[id] || null;
    const complete = COMPLETE.has(r.result);
    const pending = complete && needsRuling(r, expected) && !ruling;
    return { id, expected, r, ruling, complete, pending, scorable: complete && !pending };
  });

  // Q1
  const q1Rows = view.filter((v) => v.expected === 'finalize').map((v) => {
    const { r, ruling } = v;
    let status;
    if (!v.complete) status = 'incomplete';
    else if (r.result !== 'checklist') status = 'fail';                       // a safe refusal on a supported request is a failure
    else if (r.mechanical_pass !== true) status = 'fail';
    else if (!ruling) status = 'pending';
    else status = ruling.faithful === true && ruling.invented_requirement_or_default !== true && ruling.omitted_required_protection !== true ? 'pass' : 'fail';
    return { id: v.id, result: r.result, status };
  });
  const hard = view.filter((v) => finalizedRow(v.r) && v.ruling && (v.ruling.invented_requirement_or_default === true || v.ruling.omitted_required_protection === true)).map((v) => v.id);
  const q1Pass = q1Rows.filter((x) => x.status === 'pass').length;
  const q1Fail = q1Rows.filter((x) => x.status === 'fail').length;
  const Q1 = { passed: q1Pass, of: sup.length, min: policy.q1_min_supported, invented_or_omitted: hard, rows: q1Rows,
    status: hard.length || q1Fail > sup.length - policy.q1_min_supported ? 'fail' : q1Rows.every((x) => x.status === 'pass' || x.status === 'fail') ? (q1Pass >= policy.q1_min_supported ? 'pass' : 'fail') : 'incomplete' };

  // Q2
  const accepted = view.flatMap((v) => (v.r.incorrect_acceptance || []).map((c) => `${v.id}:${c}`));
  const weakened = view.filter((v) => (v.r.scope && ((v.r.scope.missing_protect || []).length || !Object.values(v.r.scope.scope_controls || {}).every((y) => y.refused_by_protected_paths)))
    || (v.ruling && v.ruling.protected_scope_weakened === true)).map((v) => v.id);
  const Q2 = { incorrect_control_acceptance: accepted, protected_scope_weakened: weakened,
    status: accepted.length || weakened.length ? 'fail' : view.every((v) => v.scorable) ? 'pass' : 'incomplete' };

  // Q3
  const q3Rows = view.filter((v) => v.expected === 'refuse').map((v) => {
    const { r, ruling } = v;
    const fabricated = finalizedRow(r) || (ruling && ruling.fabricated_answer === true);
    let status;
    if (fabricated) status = 'fail';
    else if (!v.complete) status = 'incomplete';
    else if (r.result !== 'intended_refusal') status = 'fail';
    else if (!ruling) status = 'pending';
    else status = ruling.refusal_reason_correct === true ? 'pass' : 'fail';
    return { id: v.id, result: r.result, decision: r.decision ? r.decision.kind : null, fabricated: Boolean(fabricated), status };
  });
  const Q3 = { passed: q3Rows.filter((x) => x.status === 'pass').length, of: ref.length, fabricated: q3Rows.filter((x) => x.fabricated).map((x) => x.id), rows: q3Rows,
    status: q3Rows.some((x) => x.status === 'fail') ? 'fail' : q3Rows.every((x) => x.status === 'pass') && q3Rows.length === policy.refusal_n ? 'pass' : 'incomplete' };

  // Q4 (full elapsed L1 time, cold load included)
  const timed = view.filter((v) => Number.isFinite(v.r.l1_ms));
  const full = timed.map((v) => v.r.l1_ms);
  const over = timed.filter((v) => v.r.l1_ms > policy.q4_max_ms).map((v) => v.id);
  const excl = timed.filter((v) => Number.isFinite(v.r.l1_load_excluded_ms)).map((v) => v.r.l1_load_excluded_ms);
  const med = median(full);
  const Q4 = { basis: 'full elapsed L1 time (l1_ms), cold load included', timings: timed.length, of: roster.length,
    missing: view.filter((v) => !Number.isFinite(v.r.l1_ms)).map((v) => v.id), median_ms: med, max_ms: full.length ? Math.max(...full) : null,
    median_target_ms: policy.q4_median_ms, max_target_ms: policy.q4_max_ms, over_max: over,
    secondary_load_excluded: { note: 'secondary only; never the gate', median_ms: median(excl), max_ms: excl.length ? Math.max(...excl) : null, timings: excl.length },
    cold_items: view.filter((v) => v.r.cold_load === true).map((v) => v.id),
    status: over.length ? 'fail' : timed.length < roster.length ? 'incomplete' : med <= policy.q4_median_ms ? 'pass' : 'fail' };

  // Q5
  const notComplete = view.filter((v) => !v.complete).map((v) => ({ id: v.id, result: v.r.result }));
  const pending = view.filter((v) => v.pending).map((v) => v.id);
  const Q5 = { complete: view.filter((v) => v.complete).length, of: roster.length, not_complete: notComplete, pending_ruling: pending,
    status: notComplete.length || pending.length || problems.length ? 'fail' : 'pass' };

  const gates = { Q1, Q2, Q3, Q4, Q5 };
  const verdict = ['Q1', 'Q2', 'Q3', 'Q4'].some((g) => gates[g].status === 'fail') ? 'fail'
    : Object.values(gates).every((g) => g.status === 'pass') ? 'pass' : 'incomplete';
  return { schema: 'qb-kan106-eval-v2-gates/1', profile, verdict, roster_problems: problems, gates,
    note: 'One profile only; never pooled or inferred from another. An incomplete profile is not passed; observed failures are reported regardless.' };
}

module.exports = { evaluateProfile, median, COMPLETE };
