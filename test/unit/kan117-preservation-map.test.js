// KAN-117 (senior F1, after 10653): on the research path a preservation criterion is decided clause by clause from a
// controller-held, reviewer-approved evidence map of EXACT test identities (+ bound checks), through the REAL
// execute() + verify(). A real failure of a mapped test fails the clause; missing, excluded or invalid evidence leaves it
// unresolved; a passing check alone can never satisfy the criterion. Toy data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { execute } = require('../../agent/runner');
const { verify } = require('../../verify/verifier');
const { checkSetHash } = require('../../verify/checks/registry');
const { validateResearchChecks } = require('../../lib/research/reviewed-checks');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const FILE = 'test/x.js';
const id = (t) => sha(`${FILE}\0${t}`);
const T1 = id('suite keeps a'); const T2 = id('suite keeps b'); const TX = id('suite env-dependent');
const S1 = "module.exports = async ({ require, assert }) => { assert.equal(require('./src/a.js').a, 2); };";
const S2 = "module.exports = async ({ require, assert }) => { assert.ok(require('./src/a.js')); };";
const AC = [
  { id: 'AC-1', criterion: 'a is 2', met: null, kind: 'behavioral' },
  { id: 'AC-2', criterion: 'Preservation: a and b still work; HEAD still works', met: null, kind: 'behavioral', preserves: { tests: [FILE] } },
];
const RAW = [{ id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', params: { source: S1 } }, { id: 'SC-2', ac_id: 'AC-2', adapter: 'scenario', params: { source: S2 } }];
const CHECKS = validateResearchChecks(RAW, AC, { reviewed: [S1, S2].map((s, i) => ({ check_id: `SC-${i + 1}`, source_sha256: sha(s), reviewed_by: 'fixture', ref: 'fixture' })) }).accepted;
const H = checkSetHash(CHECKS);
const contract = approve({ id: 'c', goal: 'Set a to 2', acceptance_criteria: AC, clarifying_question: null, checks: CHECKS, checks_registry: 'qb-checks/3',
  scope: { allowed_changes: ['src/**'] }, test_policy: { preexisting_failures: 'waive' } }, { via: 'test' });
const BASE = 'b'.repeat(40);
const MAP = { schema: 'qb-preservation-map/1', ac_id: 'AC-2', file: FILE, base_commit: BASE, clauses: [
  { id: 'P-1', clause: 'a and b still work', tests: [T1, T2], checks: [] },
  { id: 'P-2', clause: 'HEAD still works', tests: [], checks: ['SC-2'] },
] };
const approved = (m = MAP) => [{ map: m, sha256: sha(JSON.stringify(m)), reviewed_by: 'fixture', ref: 'fixture' }];
const ident = (i, statuses, extra = {}) => ({ id: i, file: FILE, count: statuses.length, statuses, kinds: statuses.includes('failed') ? ['assertion'] : [], codes: [], ...extra });
const ver = (identities, o = {}) => {
  const failing = identities.filter((e) => e.statuses.includes('failed')).map((e) => ({ id: e.id, file: e.file, full_title: 'x', kinds: e.kinds, codes: e.codes, failed_count: 1 }));
  return { mode: 'research_mocha', test_plan: { runner: 'mocha' }, status: 'ran', verdict: failing.length ? 'failed' : 'passed', reasons: [],
    validation: { counts: { total: identities.length, passed: identities.length - failing.length, failed: failing.length }, identities, failing }, steps: [{ name: 'test', exit_code: failing.length ? 1 : 0 }],
    prep: { status: 'ready', tree: 't', protected_modified: [] }, task_base_commit: BASE, protected: [':(glob)test/**', 'gulpfile.js'], ...o };
};
const res = (i, status = 'pass') => ({ id: i, ac_id: i === 'SC-1' ? 'AC-1' : 'AC-2', adapter: 'scenario', status, detail: status });
const doc = (results) => JSON.stringify({ format: 'qb-check-results/1', complete: true, check_set_hash: H, results });
const ALL = [ident(T1, ['passed']), ident(T2, ['passed'])];
async function run(verification, { checks = [res('SC-1'), res('SC-2')], maps = approved() } = {}) {
  const exec = await execute('task', contract, null, { agent: 'claude-code', repoPath: '/repo', runSandboxed: async () => ({
    status: 'completed', diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-exports.a = 1;\n+exports.a = 2;\n',
    changes: [{ file: 'src/a.js', status: 'M', additions: 1, deletions: 1, binary: false }], candidate_tree: 't',
    sandbox: { verification, checks: { requested: CHECKS, check_set_hash: H, results_text: doc(checks), state: 'completed', tree: 't' } } }) });
  const f = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
  try { const r = await verify(contract, null, exec, { repoPath: '/repo', ...(maps ? { preservationMaps: maps } : {}) }); return { r, ac: r.criteria_results.find((c) => c.id === 'AC-2') }; } finally { f.restore(); }
}

test('every mapped test passed and the bound check passed → the preservation criterion is met (verdict can pass)', async () => {
  const { r, ac } = await run(ver(ALL));
  assert.equal(ac.met, true, ac.evidence);
  assert.equal(r.verdict, 'pass');
  assert.equal(ac.method, 'test-identity-map');
  assert.deepEqual(ac.clauses.map((c) => [c.id, c.met]), [['P-1', true], ['P-2', true]]);
});
test('a REAL failure of a mapped test fails the criterion (false, with a repair hint)', async () => {
  const { r, ac } = await run(ver([ident(T1, ['passed']), ident(T2, ['failed'])]));
  assert.equal(ac.met, false);
  assert.ok(ac.repair);
  assert.notEqual(r.verdict, 'pass');
  assert.equal(ac.clauses[0].tests.find((t) => t.id === T2).status, 'failed');
});
test('missing, excluded or invalid evidence for a mapped test leaves the criterion unresolved (never met, never false)', async () => {
  const cases = {
    missing: ver([ident(T1, ['passed'])]),
    pending: ver([ident(T1, ['passed']), ident(T2, ['pending'])]),
    'excluded (listed exception, failing)': ver([ident(T1, ['passed']), ident(T2, ['failed'])], { known_base_failures: { entries: [{ id: T2, file: FILE, kinds: ['assertion'], codes: [], count: 1 }] } }),
    'excluded (listed exception, passing)': ver(ALL, { known_base_failures: { entries: [{ id: T2, file: FILE, kinds: ['assertion'], codes: [], count: 1 }] } }),
    'excluded (isolation re-check)': ver(ALL, { known_base_failures: { entries: [], isolation_rechecks: [{ id: T1, file: FILE }] } }),
    'channel error': ver(ALL, { verdict: 'error', reasons: ['identity_drift'] }),
    'no identities': ver(ALL, { validation: { counts: { total: 2, passed: 2, failed: 0 }, failing: [] } }),
  };
  for (const [why, v] of Object.entries(cases)) {
    const { r, ac } = await run(v);
    assert.equal(ac.met, null, `${why}: ${ac.evidence}`);
    assert.notEqual(r.verdict, 'pass', why);
  }
});
test('the bound check alone can never satisfy the criterion: tests unresolved + check pass → unresolved; check fail → false', async () => {
  assert.equal((await run(ver([ident(T1, ['passed'])]))).ac.met, null);
  assert.equal((await run(ver(ALL), { checks: [res('SC-1'), res('SC-2', 'fail')] })).ac.met, false);
  assert.equal((await run(ver(ALL), { checks: [res('SC-1'), res('SC-2', 'error')] })).ac.met, null);
});
test('a map is rejected (criterion unresolved) unless approved by exact hash, complete and test-bearing', async () => {
  const bad = {
    'hash mismatch': [{ ...approved()[0], sha256: 'f'.repeat(64) }],
    'checks only, no existing tests': approved({ ...MAP, clauses: [{ id: 'P-2', clause: 'HEAD still works', tests: [], checks: ['SC-2'] }] }),
    'a clause with no evidence': approved({ ...MAP, clauses: [...MAP.clauses, { id: 'P-3', clause: 'x', tests: [], checks: [] }] }),
    'unknown check': approved({ ...MAP, clauses: [MAP.clauses[0], { id: 'P-2', clause: 'h', tests: [], checks: ['SC-9'] }] }),
    'check bound to another criterion': approved({ ...MAP, clauses: [MAP.clauses[0], { id: 'P-2', clause: 'h', tests: [], checks: ['SC-1'] }] }),
    'a bound check left out of the map': approved({ ...MAP, clauses: [MAP.clauses[0]] }),
    'file not preserved by the criterion': approved({ ...MAP, file: 'test/y.js' }),
    'malformed test id': approved({ ...MAP, clauses: [{ ...MAP.clauses[0], tests: ['abc'] }, MAP.clauses[1]] }),
    'no map at all': null,
  };
  for (const [why, maps] of Object.entries(bad)) {
    const { ac } = await run(ver(ALL), { maps });
    assert.equal(ac.met, null, `${why}: ${ac.evidence}`);
  }
});
test('ordinary (non-research) runs ignore the map and keep the file-level rule', async () => {
  const { ac } = await run({ status: 'ran', exit_code: 0, verdict: 'passed' });
  assert.notEqual(ac.method, 'test-identity-map');
});

test('mapped results must come from THIS candidate and the frozen (base-restored) test definitions, not merely matching names', async () => {
  const cases = {
    'tests ran on another tree than the candidate': ver(ALL, { prep: { status: 'ready', tree: 'other', protected_modified: [] } }),
    'no verify-prep record (protected tests not restored)': ver(ALL, { prep: undefined }),
    'verify-prep not ready': ver(ALL, { prep: { status: 'dependency_change_required', tree: 't' } }),
    'a different task base': ver(ALL, { task_base_commit: 'c'.repeat(40) }),
    'the mapped file is not restored from the base': ver(ALL, { protected: ['gulpfile.js'] }),
    'no protected list': ver(ALL, { protected: undefined }),
  };
  for (const [why, v] of Object.entries(cases)) {
    const { r, ac } = await run(v);
    assert.equal(ac.met, null, `${why}: ${ac.evidence}`);
    assert.notEqual(r.verdict, 'pass', why);
  }
  // the candidate editing the mapped test file is restored before the run: names match AND definitions are the base's
  assert.equal((await run(ver(ALL, { prep: { status: 'ready', tree: 't', protected_modified: [FILE] } }))).ac.met, true);
});
