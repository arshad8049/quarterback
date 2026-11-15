/**
 * verify/research-adapter.js — KAN-117 (senior direction after 10624): RESEARCH-ONLY mapping from QB's visible research
 * channel (lib/research/verify-stage.js; mode research_mocha / research_jest) onto the outcomes QB's real verdict and
 * repair logic use (verify/tests.js classifyTestRun shape). Ordinary customer runs never reach this file.
 *
 * Trust: every outcome is labelled ADVISORY. The visible channel shares its process with code the candidate imports,
 * so a complete rewrite of the report is not detectable (KAN-117 10624); it can steer QB's verify/repair decisions but is
 * never trusted or "verified" evidence. The independent grader stays authoritative.
 *
 * Existing base failures: only a FROZEN, APPROVED exception list (validateKnownBaseFailures) can excuse them, and only
 *   - each entry by exact identity (sha256 of file + full title), file, sorted error kinds, sorted error codes and count;
 *   - and only when the approved contract says test_policy.preexisting_failures: "waive".
 * Anything else that fails is a regression: a NEW failure (not listed) or a CHANGED failure (listed, but kind, code or
 * count differ). Missing, unexpected or drifted tests, timeouts and harness errors are errors (never PASS) — the
 * channel's validator reports them before this mapping, so no exception can hide them.
 */

const ADVISORY = { trust: 'advisory', trust_note: 'visible research channel: unauthenticated (same-process reporter), advisory only; the independent grader is authoritative' };
const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/** Approved entries only (an unapproved list excuses nothing). */
function approvedEntries(v) {
  const x = v && v.known_base_failures;
  return x && typeof x.approved_by === 'string' && x.approved_by && Array.isArray(x.entries) ? x.entries : [];
}

function classifyResearchRun(v, { preexisting = 'block' } = {}) {
  const step = Array.isArray(v.steps) ? v.steps.find((s) => s.name === 'test') : null;
  const exit_code = step && Number.isInteger(step.exit_code) ? step.exit_code : null;
  const counts = v.validation && v.validation.counts ? v.validation.counts : null;
  const runner = (v.test_plan && v.test_plan.runner) || String(v.mode).replace(/^research_/, '');
  const res = (outcome, reason, extra = {}) => ({ outcome, reason, runner, counts, exit_code, ...ADVISORY, ...extra });

  if (v.status !== 'ran') return res('not_run', v.reason || 'not_run');
  if (v.verdict === 'stage_timeout') return res('error', 'timeout');
  if (v.verdict === 'build_failed') return res('error', `build_failed${v.failed_step ? `: ${v.failed_step}` : ''}`);
  if (v.verdict === 'passed') return res('passed', 'tests_passed');
  if (v.verdict !== 'failed') return res('error', (v.reasons && v.reasons.length ? v.reasons.join('+') : 'research_channel_error'));

  // failed: split the failing tests into frozen exceptions and regressions (new or changed)
  const failing = (v.validation && Array.isArray(v.validation.failing)) ? v.validation.failing : null;
  if (!failing) return res('error', 'no_failing_test_detail');
  const ex = new Map(approvedEntries(v).map((e) => [e.id, e]));
  const regressions = []; const excepted = [];
  for (const f of failing) {
    const e = ex.get(f.id);
    const item = { file: f.file, name: f.full_title, failureType: (f.kinds && f.kinds[0]) || null,
      error: `${(f.kinds || []).join('/')}${f.codes && f.codes.length ? ` (${f.codes.join('/')})` : ''}`.slice(0, 500) };
    if (!e) { regressions.push(item); continue; }
    const exact = e.file === f.file && same(e.kinds, f.kinds) && same(e.codes, f.codes) && e.count === f.failed_count;
    if (exact) excepted.push(item); else regressions.push({ ...item, changed_failure: true });
  }
  const known = { failures: [...regressions, ...excepted], regressions, preexisting: excepted, baseline: 'frozen_exception_list' };
  if (regressions.length) return res('failed', 'tests_failed', known);
  return preexisting === 'waive'
    ? res('preexisting_failures', 'only_frozen_exceptions', known)
    : res('failed', 'preexisting_failures_not_waived', known);
}

const isResearch = (v) => Boolean(v && typeof v.mode === 'string' && v.mode.startsWith('research_'));

module.exports = { classifyResearchRun, isResearch, ADVISORY };
