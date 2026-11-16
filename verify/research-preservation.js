/**
 * verify/research-preservation.js — KAN-117 (senior F1, after 10653): RESEARCH-ONLY clause-level preservation evidence.
 *
 * On the research channel there is no per-file report, so a preservation criterion (preserves.tests) cannot be decided
 * at file level — and a file with excluded (environment-dependent) tests could never honestly "pass". Instead the
 * controller supplies a reviewer-approved EVIDENCE MAP, accepted only by its exact sha256, that binds each clause of the
 * criterion to EXACT test identities (sha256(file + NUL + full Mocha title)) and/or checks bound to the criterion.
 *
 * Per mapped test:  passed (every execution passed) | failed (a real failure) | missing (not executed) |
 *                   excluded (listed as an exception or isolation re-check: never counted as passing) | invalid (pending…)
 * Per clause:       any failed test or failed check → false; every test passed and every check passed → true; else null.
 * Criterion:        any clause false → false; every clause true → true; else null (unresolved).
 * The map must name at least one existing test and cover every check bound to the criterion, so a passing check alone can
 * never satisfy it. Unusable channel evidence (error, drift, no identities) leaves everything unresolved.
 * Binding (senior, after 10654): the mapped results count only if they belong to THIS candidate and the FROZEN test
 * definitions — the tests ran on the candidate's tree (verify-prep tree === execution.candidate_tree), the run's task base
 * is the map's base_commit, and the mapped file lies under the env record's protected patterns, which verify-prep restores
 * from that base before the run (any candidate edit to it is undone). Matching names alone never suffice.
 * Ordinary customer runs never reach this file.
 */
const crypto = require('crypto');

const HEX = /^[0-9a-f]{64}$/;
// a protected pattern covers the file: exact path, or a ':(glob)dir/**' / 'dir/**' prefix (the env record's forms)
const covers = (pat, f) => { const p = String(pat).replace(/^:\(glob\)/, ''); return p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : p === f; };
function bindingError(v, map, candidateTree) {
  const prep = v && v.prep;
  if (!prep || prep.status !== 'ready') return 'no ready verify-prep record (protected tests not shown restored)';
  if (!candidateTree || prep.tree !== candidateTree) return 'tests did not run on the candidate tree';
  if (!map.base_commit || v.task_base_commit !== map.base_commit) return 'test run base is not the map base_commit';
  if (!Array.isArray(v.protected) || !v.protected.some((p) => covers(p, map.file))) return `${map.file} is not restored from the base before the run`;
  return null;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The approved map for this criterion, or { error }. */
function acceptMap(ac, approvals, checks) {
  const forAc = (approvals || []).filter((a) => a && a.map && a.map.ac_id === ac.id);
  if (!forAc.length) return { error: 'no reviewer-approved evidence map for this criterion' };
  if (forAc.length > 1) return { error: 'more than one evidence map for this criterion' };
  const { map, sha256 } = forAc[0];
  if (sha(JSON.stringify(map)) !== sha256) return { error: 'evidence map does not match its approved sha256' };
  if (map.schema !== 'qb-preservation-map/1') return { error: 'evidence map schema' };
  if (!(ac.preserves && ac.preserves.tests || []).includes(map.file)) return { error: `evidence map file ${map.file} is not preserved by ${ac.id}` };
  const bound = (checks || []).filter((c) => c.ac_id === ac.id).map((c) => c.id);
  if (!Array.isArray(map.clauses) || !map.clauses.length) return { error: 'evidence map has no clauses' };
  const ids = new Set(); const used = new Set(); let tests = 0;
  for (const c of map.clauses) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || !Array.isArray(c.tests) || !Array.isArray(c.checks)) return { error: 'malformed clause' };
    ids.add(c.id);
    if (!c.tests.length && !c.checks.length) return { error: `${c.id} has no evidence` };
    if (!c.tests.every((t) => typeof t === 'string' && HEX.test(t))) return { error: `${c.id}: test ids must be sha256 identities` };
    for (const k of c.checks) { if (!bound.includes(k)) return { error: `${c.id}: check ${k} is not a check bound to ${ac.id}` }; used.add(k); }
    tests += c.tests.length;
  }
  if (!tests) return { error: 'evidence map names no existing test (a check alone cannot satisfy preservation)' };
  const left = bound.filter((k) => !used.has(k));
  if (left.length) return { error: `checks bound to ${ac.id} missing from the map: ${left.join(', ')}` };
  return { map, sha256 };
}

function testStatus(i, byId, excluded) {
  if (excluded.has(i)) return 'excluded';
  const e = byId.get(i);
  if (!e) return 'missing';
  if (!Array.isArray(e.statuses) || !e.statuses.length) return 'invalid';
  if (e.statuses.includes('failed')) return 'failed';
  return e.statuses.every((s) => s === 'passed') ? 'passed' : 'invalid';
}

/**
 * @param ac            preservation criterion
 * @param v             research verification (sandbox.verification)
 * @param classified    classifyResearchRun() result
 * @param ev            evaluateChecks() result
 * @param approvals     [{ map, sha256, reviewed_by, ref }] supplied by the controller
 * @param checks        the contract's accepted checks
 * @param candidateTree execution.candidate_tree
 */
function decideMappedPreservation(ac, v, classified, ev, approvals, checks, candidateTree) {
  const base = { id: ac.id, criterion: ac.criterion, method: 'test-identity-map' };
  const m = acceptMap(ac, approvals, checks);
  if (m.error) return { ...base, met: null, evidence: `Preservation not verified: ${m.error}.` };
  const usable = classified && ['passed', 'failed', 'preexisting_failures'].includes(classified.outcome)
    && v && v.validation && Array.isArray(v.validation.identities);
  if (!usable) return { ...base, met: null, map_sha256: m.sha256, evidence: `Preservation not verified: test evidence unusable (${classified ? classified.reason : 'no test run'}).` };
  const bind = bindingError(v, m.map, candidateTree);
  if (bind) return { ...base, met: null, map_sha256: m.sha256, evidence: `Preservation not verified: ${bind}.` };
  const byId = new Map(v.validation.identities.map((e) => [e.id, e]));
  const x = v.known_base_failures || {};
  const excluded = new Set([...(x.entries || []), ...(x.isolation_rechecks || [])].map((e) => e && e.id));
  const results = new Map(((ev && ev.results) || []).map((r) => [r.id, r]));
  const checkUsable = ev && !ev.error;
  const clauses = m.map.clauses.map((c) => {
    const tests = c.tests.map((i) => ({ id: i, status: testStatus(i, byId, excluded) }));
    const ks = c.checks.map((k) => ({ id: k, status: checkUsable && results.has(k) ? results.get(k).status : 'missing' }));
    const st = [...tests.map((t) => t.status), ...ks.map((k) => (k.status === 'pass' ? 'passed' : k.status === 'fail' ? 'failed' : 'unresolved'))];
    const met = st.includes('failed') ? false : st.every((s) => s === 'passed') ? true : null;
    return { id: c.id, clause: c.clause, met, tests, checks: ks };
  });
  const met = clauses.some((c) => c.met === false) ? false : clauses.every((c) => c.met === true) ? true : null;
  const tally = (s) => clauses.flatMap((c) => c.tests).filter((t) => t.status === s).length;
  const evidence = `${m.map.file}: mapped tests ${tally('passed')} passed, ${tally('failed')} failed, ${tally('excluded')} excluded, ${tally('missing')} missing, ${tally('invalid')} invalid; `
    + clauses.map((c) => `${c.id}=${c.met}`).join(', ');
  return { ...base, met, clauses, map_sha256: m.sha256, evidence,
    repair: met === false ? `Keep these behaviours working without editing their tests: ${clauses.filter((c) => c.met === false).map((c) => c.clause).join('; ')}` : null };
}

module.exports = { decideMappedPreservation, acceptMap };
