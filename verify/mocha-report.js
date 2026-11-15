/**
 * verify/mocha-report.js — KAN-117 review 10620: validate one qb-mocha-events/1 report from QB's research-only
 * Mocha channel (sandbox/research/qb-mocha-reporter.cjs). Machine-readable output only, never console text.
 *
 *   passed  exit 0, a complete, CURRENT (nonce + start time) report, consistent with Mocha's own runner stats,
 *           the executed file set == the explicit file set, >=1 test passed, no hook failure, and (with a
 *           baseline) the exact identity multiset and pending statuses of the base
 *   failed  the same validity, with at least one failing test (a correctly parsed failure)
 *   error   anything that cannot be trusted: zero tests, a missing/truncated/corrupt/stale/foreign report,
 *           a hook failure, counts or exit code that disagree, a version mismatch, missing or extra tests
 *
 * Identities are sha256(relative file + NUL + full title), so results carry no test names.
 * Residual (stated, not hidden): the reporter shares the process with the tests, as QB's node:test reporter does;
 * the nonce and start time stop stale or foreign reports, appended forgeries break the single start/end rule, but
 * test code that rewrites the whole file is not prevented here. The score comes from the independent grader.
 */

const crypto = require('crypto');

const FORMAT = 'qb-mocha-events/1';
const STALE_SKEW_MS = 2000;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const STATES = new Set(['passed', 'failed', 'pending']);

function rel(root, p) {
  const r = String(p);
  return r.startsWith(`${root}/`) ? r.slice(root.length + 1) : null;
}

/**
 * @param {object} o
 * @param {string|null} o.reportText   the report file (null: none written)
 * @param {number|null} o.exitCode     exit code of the test run
 * @param {number} o.startedAtMs       host clock just before the run container started
 * @param {string} o.nonce             the nonce QB passed to this run
 * @param {string} o.root              repo root inside the container (/verify)
 * @param {string[]} o.files           the explicit visible file set (relative)
 * @param {string} o.mochaVersion      the pinned exact version
 * @param {object|null} [o.baseline]   baselineFrom() of the base run
 */
function validateMochaRun(o) {
  const reasons = [];
  const out = { verdict: 'error', reasons, counts: null, identities: [], identity_set_sha256: null, files_expected: (o.files || []).length, files_executed: null };
  if (typeof o.reportText !== 'string') { reasons.push('no_report'); return out; }
  if (!o.reportText.endsWith('\n')) { reasons.push('incomplete_report'); return out; }
  const ev = [];
  for (const line of o.reportText.slice(0, -1).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { reasons.push('malformed_report'); return out; }
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string') { reasons.push('malformed_report'); return out; }
    ev.push(e);
  }
  const starts = ev.filter((e) => e.type === 'qb:start').length;
  const ends = ev.filter((e) => e.type === 'qb:end').length;
  if (ev[0]?.type !== 'qb:start' || ev[0].format !== FORMAT || starts !== 1 || ends > 1) { reasons.push('malformed_report'); return out; }
  if (ev.at(-1).type !== 'qb:end') { reasons.push('incomplete_report'); return out; }
  const start = ev[0]; const end = ev.at(-1);
  if (start.nonce !== o.nonce) reasons.push('nonce_mismatch');
  if (start.mocha_version !== o.mochaVersion) reasons.push('mocha_version_mismatch');
  if (!Number.isFinite(start.started_at) || start.started_at < o.startedAtMs - STALE_SKEW_MS) reasons.push('stale_report');

  const tally = { passed: 0, failed: 0, pending: 0 };
  let hooks = 0;
  const byId = new Map();
  const executed = new Set();
  for (const e of ev.slice(1, -1)) {
    if (e.type === 'suite') {
      const f = rel(o.root, e.file);
      if (!f) { reasons.push('malformed_report'); return out; }
      executed.add(f);
    } else if (e.type === 'test') {
      const f = rel(o.root, e.file);
      if (!f || typeof e.full_title !== 'string' || !STATES.has(e.state)) { reasons.push('malformed_report'); return out; }
      tally[e.state] += 1;
      const id = hash(`${f}\0${e.full_title}`);
      const x = byId.get(id) || { id, file: f, leaf_sha256: typeof e.title === 'string' ? hash(e.title) : null, count: 0, statuses: [], kinds: [], codes: [] };
      x.count += 1; x.statuses.push(e.state);
      if (e.state === 'failed') { x.kinds.push(typeof e.error_kind === 'string' ? e.error_kind : 'unknown'); if (typeof e.error_code === 'string') x.codes.push(e.error_code); }
      byId.set(id, x);
    } else if (e.type === 'hook_fail') {
      hooks += 1;
      out.hook_kinds = [...(out.hook_kinds || []), typeof e.error_kind === 'string' ? e.error_kind : 'unknown'];
    } else { reasons.push('malformed_report'); return out; }
  }
  const s = end.stats || {};
  const total = tally.passed + tally.failed + tally.pending;
  if (![s.tests, s.passes, s.pending, s.failures].every((n) => Number.isInteger(n) && n >= 0)
    || s.passes !== tally.passed || s.pending !== tally.pending || s.failures !== tally.failed + hooks || s.tests !== total) reasons.push('inconsistent_counts');
  out.counts = { total, passed: tally.passed, failed: tally.failed, pending: tally.pending, hook_failures: hooks, files: executed.size };
  out.files_executed = executed.size;
  if (total === 0) reasons.push('zero_tests');
  if (hooks > 0) reasons.push('hook_failure');
  const want = [...new Set(o.files || [])].sort(); const got = [...executed].sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) reasons.push('discovery_mismatch');
  out.identities = [...byId.values()].map((e) => ({ ...e, statuses: e.statuses.sort(), kinds: e.kinds.sort(), codes: e.codes.sort() })).sort((a, b) => (a.id < b.id ? -1 : 1));
  out.identity_set_sha256 = hash(JSON.stringify(out.identities));

  const failures = tally.failed + hooks;
  if (!Number.isInteger(o.exitCode) || (failures > 0 ? o.exitCode === 0 : o.exitCode !== 0)) reasons.push('exit_contradicts_report');

  if (o.baseline) {
    const base = new Map(o.baseline.identities.map((e) => [e.id, e]));
    let missing = false; let extra = false; let drift = false;
    for (const [id, b] of base) {
      const c = byId.get(id);
      if (!c || c.count < b.count) { missing = true; continue; }
      if (b.statuses.filter((x) => x === 'pending').length !== c.statuses.filter((x) => x === 'pending').length) drift = true;
    }
    for (const [id, c] of byId) if (!base.has(id) || c.count > base.get(id).count) extra = true;
    if (missing) reasons.push('missing_executions');
    if (extra) reasons.push('unexpected_tests');
    if (drift) reasons.push('status_drift');
  }

  if (reasons.length) return out;
  if (tally.failed > 0) { out.verdict = 'failed'; return out; }
  out.verdict = tally.passed > 0 ? 'passed' : 'error';
  if (out.verdict === 'error') reasons.push('no_passing_tests');
  return out;
}

/**
 * The baseline a later candidate run must match, from a VALID base run. Unlike Jest stage B, a base run with
 * existing failures is a valid baseline (review 10620: report visible results honestly; never require the
 * unchanged code to fail or pass).
 */
function baselineFrom(v) {
  if (!v || !['passed', 'failed'].includes(v.verdict)) throw new Error('baseline needs a valid base run (passed or failed), not an error');
  return { schema: 'qb-kan117-mocha-baseline/1', base_verdict: v.verdict, identities: v.identities, identity_set_sha256: v.identity_set_sha256, counts: v.counts };
}

module.exports = { FORMAT, validateMochaRun, baselineFrom };
