/**
 * verify/jest-report.js — KAN-117 (review 10607): validate one Jest `--json --outputFile` report
 * from QB's research-only internal channel. Machine-readable output only, never console text.
 *
 *   passed  exit 0, a complete, current, consistent report, discovery == execution, >=1 test passed,
 *           and (with a baseline) the exact identity multiset and pending statuses of the base
 *   failed  the same validity, with at least one failing test (a correctly parsed failure)
 *   error   anything that cannot be trusted (a broken harness is never a test result)
 *
 * Identities are sha256(relative file + NUL + fullName), so artifacts carry no test names.
 */

const crypto = require('crypto');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const STALE_SKEW_MS = 2000;
const STATUSES = new Set(['passed', 'failed', 'pending', 'todo', 'skipped', 'disabled', 'focused']);

function rel(root, p) {
  const r = String(p);
  return r.startsWith(`${root}/`) ? r.slice(root.length + 1) : null;
}

/**
 * @param {object} o
 * @param {string|null} o.reportText  the --outputFile contents (null: none written)
 * @param {string|null} o.listText    stdout of `jest --listTests --json`
 * @param {number|null} o.exitCode    exit code of the test run
 * @param {number} o.startedAtMs      host clock just before the run container started
 * @param {string} o.root             repo root inside the container (/verify)
 * @param {object|null} [o.baseline]  baselineFrom() of the base run
 */
function validateJestRun(o) {
  const reasons = [];
  const out = { verdict: 'error', reasons, counts: null, identities: [], identity_set_sha256: null, listed: null, executed: null };
  if (typeof o.reportText !== 'string') { reasons.push('no_report'); return out; }
  let rep;
  try { rep = JSON.parse(o.reportText); } catch { reasons.push('malformed_report'); return out; }
  const num = (k) => Number.isInteger(rep[k]) && rep[k] >= 0;
  if (!rep || typeof rep !== 'object' || !Array.isArray(rep.testResults) || typeof rep.success !== 'boolean'
    || !['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numRuntimeErrorTestSuites'].every(num)
    || !Number.isFinite(rep.startTime)) { reasons.push('malformed_report'); return out; }

  if (rep.startTime < o.startedAtMs - STALE_SKEW_MS) reasons.push('stale_report');
  if (rep.numRuntimeErrorTestSuites > 0 || rep.testResults.some((f) => f.testExecError)) reasons.push('runtime_error_suite');

  // identities and per-status counts from the per-test results
  const byId = new Map();
  const tally = { passed: 0, failed: 0, pending: 0, todo: 0, other: 0 };
  const executed = [];
  for (const f of rep.testResults) {
    const file = rel(o.root, f && f.name);
    if (!file || !Array.isArray(f.assertionResults)) { reasons.push('malformed_report'); return out; }
    executed.push(file);
    for (const a of f.assertionResults) {
      if (!a || typeof a.fullName !== 'string' || !STATUSES.has(a.status)) { reasons.push('malformed_report'); return out; }
      const st = a.status === 'skipped' || a.status === 'disabled' ? 'pending' : a.status;
      if (tally[st] === undefined) tally.other += 1; else tally[st] += 1;
      const id = hash(`${file}\0${a.fullName}`);
      const e = byId.get(id) || { id, count: 0, statuses: [] };
      e.count += 1; e.statuses.push(st); byId.set(id, e);
    }
  }
  const total = tally.passed + tally.failed + tally.pending + tally.todo + tally.other;
  if (total !== rep.numTotalTests || tally.passed !== rep.numPassedTests || tally.failed !== rep.numFailedTests) reasons.push('inconsistent_counts');
  out.counts = { total, passed: tally.passed, failed: tally.failed, pending: tally.pending, todo: tally.todo, suites: rep.testResults.length };
  if (total === 0) reasons.push('zero_tests');
  out.identities = [...byId.values()].map((e) => ({ ...e, statuses: e.statuses.sort() })).sort((a, b) => (a.id < b.id ? -1 : 1));
  out.identity_set_sha256 = hash(JSON.stringify(out.identities));

  // discovery vs execution
  let listed = null;
  try { listed = JSON.parse(o.listText); } catch { listed = null; }
  if (!Array.isArray(listed) || !listed.every((x) => typeof x === 'string')) reasons.push('malformed_list');
  else {
    const L = listed.map((x) => rel(o.root, x)).sort();
    const X = [...executed].sort();
    out.listed = L.length; out.executed = X.length;
    if (L.includes(null) || JSON.stringify(L) !== JSON.stringify(X)) reasons.push('discovery_mismatch');
  }

  // exit code must agree with the report
  if (!Number.isInteger(o.exitCode) || (rep.success ? o.exitCode !== 0 : o.exitCode === 0)) reasons.push('exit_contradicts_report');

  // the protected base identities (decision: a count alone is not identity validation)
  if (o.baseline) {
    const base = new Map(o.baseline.identities.map((e) => [e.id, e]));
    let missing = false; let extra = false; let drift = false;
    for (const [id, b] of base) {
      const c = byId.get(id);
      if (!c || c.count < b.count) { missing = true; continue; }
      const bp = b.statuses.filter((s) => s === 'pending').length;
      const cp = c.statuses.filter((s) => s === 'pending').length;
      if (bp !== cp) drift = true;
    }
    for (const [id, c] of byId) if (!base.has(id) || c.count > base.get(id).count) extra = true;
    if (missing) reasons.push('missing_executions');
    if (extra) reasons.push('unexpected_tests');
    if (drift) reasons.push('status_drift');
  }

  if (reasons.length) return out;
  if (tally.failed > 0 || !rep.success) { out.verdict = 'failed'; return out; }
  out.verdict = tally.passed > 0 ? 'passed' : 'error';
  if (out.verdict === 'error') reasons.push('no_passing_tests');
  return out;
}

/** The baseline a later candidate run must match (from a valid base run). */
function baselineFrom(v) {
  if (!v || v.verdict !== 'passed') throw new Error('baseline needs a valid passing base run');
  return { schema: 'qb-kan117-jest-baseline/1', identities: v.identities, identity_set_sha256: v.identity_set_sha256, counts: v.counts };
}

module.exports = { validateJestRun, baselineFrom };
