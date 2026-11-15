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

const crypto = require('crypto');
const ISOLATION_LIMIT = 'isolation-qualified: the test failed in the full suite and passed ALONE on a fresh copy of the same tree; full-suite order safety is NOT established and interaction-only regressions can be missed; not a full-suite pass';

/**
 * Review 10631: an approval excuses anything only if it is BOUND to this run — the task base, the runtime the probe
 * observed (Node, Mocha) and the exact exception-set hash (entries + isolation re-checks cannot silently expand).
 * Image ids are bound by the frozen configuration (freeze v2) and its driver, not here.
 */
function boundApproval(v) {
  const x = v && v.known_base_failures; const a = x && x.approval;
  if (!a || !Array.isArray(x.entries)) return null;
  const set = crypto.createHash('sha256').update(JSON.stringify({ entries: x.entries, isolation_rechecks: x.isolation_rechecks || [] })).digest('hex');
  const p = v.probe || {};
  if (a.set_sha256 !== set || a.base_commit !== v.task_base_commit || a.node !== p.node || a.mocha !== p.mocha) return null;
  return x;
}
/** Approved, bound entries only (an unapproved or unbound list excuses nothing). */
function approvedEntries(v) { const x = boundApproval(v); return x ? x.entries : []; }

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
  const bound = boundApproval(v);
  const ex = new Map(approvedEntries(v).map((e) => [e.id, e]));
  const iso = new Map(((bound && bound.isolation_rechecks) || []).map((r) => [r.id, r]));
  const rechecked = new Map((Array.isArray(v.isolation_rechecks) ? v.isolation_rechecks : []).map((r) => [r.id, r]));
  const regressions = []; const excepted = []; const isolationQualified = []; const limits = [];
  for (const f of failing) {
    const e = ex.get(f.id);
    const item = { file: f.file, name: f.full_title, failureType: (f.kinds && f.kinds[0]) || null,
      error: `${(f.kinds || []).join('/')}${f.codes && f.codes.length ? ` (${f.codes.join('/')})` : ''}`.slice(0, 500) };
    const r = iso.get(f.id);
    if (r) {
      // option (c): same exact full-suite signature AND its one isolated re-check qualified; anything else blocks
      const g = r.signature;
      const sig = r.file === f.file && same(g.kinds, f.kinds) && same(g.codes, f.codes) && g.count === f.failed_count;
      const rc = rechecked.get(f.id);
      if (sig && rc && rc.verdict === 'qualified') { isolationQualified.push(item); limits.push(`${f.file}: ${ISOLATION_LIMIT}`); }
      else regressions.push({ ...item, ...(sig ? {} : { changed_failure: true }), error: `${item.error}; isolation re-check: ${rc ? `${rc.verdict}${rc.reasons && rc.reasons.length ? ` (${rc.reasons.join('+')})` : ''}` : 'not run'}`.slice(0, 500) });
      continue;
    }
    if (!e) { regressions.push(item); continue; }
    const exact = e.file === f.file && same(e.kinds, f.kinds) && same(e.codes, f.codes) && e.count === f.failed_count;
    if (exact) { excepted.push(item); limits.push(`${f.file}: ${e.justification}`.slice(0, 500)); } else regressions.push({ ...item, changed_failure: true });
  }
  const known = { failures: [...regressions, ...excepted, ...isolationQualified], regressions, preexisting: excepted, isolation_qualified: isolationQualified,
    coverage_limits: limits, baseline: 'frozen_exception_list' };
  if (regressions.length) return res('failed', 'tests_failed', known);
  const why = `only_frozen_exceptions${isolationQualified.length ? '+isolation_qualified' : ''}`;
  return preexisting === 'waive' ? res('preexisting_failures', why, known) : res('failed', 'preexisting_failures_not_waived', known);
}

const isResearch = (v) => Boolean(v && typeof v.mode === 'string' && v.mode.startsWith('research_'));

module.exports = { classifyResearchRun, isResearch, ADVISORY };
