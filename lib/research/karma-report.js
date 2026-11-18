/**
 * lib/research/karma-report.js — KAN-114 10720 (U2): validate one qb-karma-events/1 report from QB's research-only
 * Karma channel (sandbox/research/qb-karma-reporter.cjs). Machine-readable output only, never console text.
 *
 *   passed  a complete, CURRENT (nonce + start time) report from exactly one QB headless Chrome, at the pinned karma
 *           version, consistent with karma's own totals and the exit code, >=1 passing test, no browser error or
 *           disconnect, and (with a baseline) the exact identity multiset and skip statuses of the base
 *   failed  the same validity with at least one failing test
 *   error   anything that cannot be trusted (zero tests, missing/truncated/corrupt/stale/foreign report, browser error,
 *           disconnect, wrong browser, count or exit drift, missing or extra tests)
 *
 * Identities are sha256(JSON [suite path, description]); results carry no test names.
 * Residual (stated, as for the Mocha channel): the reporter runs in the karma server process alongside the repo's
 * karma config; test code in the browser cannot reach the report file, but the repo's config code runs in-process.
 * The exclusive create stops planted/appended reports; the independent grader remains the score.
 */
const crypto = require('crypto');

const FORMAT = 'qb-karma-events/1';
const STALE_SKEW_MS = 2000;
const STATES = new Set(['passed', 'failed', 'skipped']);
const BROWSER = /^HeadlessChrome /;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validateKarmaRun(o) {
  const reasons = [];
  const out = { verdict: 'error', reasons, counts: null, identities: [], identity_set_sha256: null };
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
  if (start.karma_version !== o.karmaVersion) reasons.push('karma_version_mismatch');
  if (!Number.isFinite(start.started_at) || start.started_at < o.startedAtMs - STALE_SKEW_MS) reasons.push('stale_report');

  const tally = { passed: 0, failed: 0, skipped: 0 };
  const byId = new Map();
  const browsers = [];
  let browserError = false; let disconnected = false; let complete = null;
  for (const e of ev.slice(1, -1)) {
    if (e.type === 'browser') browsers.push(String(e.name));
    else if (e.type === 'test') {
      if (!Array.isArray(e.suite) || typeof e.description !== 'string' || !STATES.has(e.state)) { reasons.push('malformed_report'); return out; }
      tally[e.state] += 1;
      const id = hash(JSON.stringify([e.suite.map(String), e.description]));
      const x = byId.get(id) || { id, count: 0, statuses: [] };
      x.count += 1; x.statuses.push(e.state);
      byId.set(id, x);
    } else if (e.type === 'browser_error') browserError = true;
    else if (e.type === 'browser_complete') { complete = e; if (e.disconnected) disconnected = true; if (e.error) browserError = true; }
    else { reasons.push('malformed_report'); return out; }
  }
  const s = end.stats || {};
  if (s.disconnected) disconnected = true;
  if (s.error) browserError = true;
  if (browsers.length !== 1 || !BROWSER.test(browsers[0])) reasons.push('wrong_browser');
  if (browserError) reasons.push('browser_error');
  if (disconnected) reasons.push('browser_disconnected');
  const total = tally.passed + tally.failed + tally.skipped;
  out.counts = { total, passed: tally.passed, failed: tally.failed, skipped: tally.skipped };
  if (s.success !== tally.passed || s.failed !== tally.failed
    || (complete && (complete.success !== tally.passed || complete.failed !== tally.failed))) reasons.push('inconsistent_counts');
  if (total === 0) reasons.push('zero_tests');
  const bad = tally.failed > 0 || browserError || disconnected;
  if (!Number.isInteger(o.exitCode) || (bad ? o.exitCode === 0 : o.exitCode !== 0)
    || (Number.isInteger(s.exit_code) && s.exit_code !== o.exitCode)) reasons.push('exit_contradicts_report');

  out.identities = [...byId.values()].map((e) => ({ ...e, statuses: e.statuses.sort() })).sort((a, b) => (a.id < b.id ? -1 : 1));
  out.identity_set_sha256 = hash(JSON.stringify(out.identities));

  if (o.baseline) {
    const base = new Map(o.baseline.identities.map((e) => [e.id, e]));
    let missing = false; let extra = false; let drift = false;
    for (const [id, b] of base) {
      const c = byId.get(id);
      if (!c || c.count < b.count) { missing = true; continue; }
      if (b.statuses.filter((x) => x === 'skipped').length !== c.statuses.filter((x) => x === 'skipped').length) drift = true;
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

/** The baseline a later run must match, from a VALID base run (existing failures are a valid baseline). */
function baselineFrom(v) {
  if (!v || !['passed', 'failed'].includes(v.verdict)) throw new Error('baseline needs a valid base run (passed or failed), not an error');
  return { schema: 'qb-kan114-karma-baseline/1', base_verdict: v.verdict, identities: v.identities, identity_set_sha256: v.identity_set_sha256, counts: v.counts };
}

module.exports = { FORMAT, validateKarmaRun, baselineFrom };
