// KAN-117 review 10642 item 1: malformed check results injected through the REAL research verifier path
// (execute() + verify() with a research_mocha verification and a reviewed scenario check) never yield PASS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { execute } = require('../../agent/runner');
const { verify } = require('../../verify/verifier');
const { checkSetHash } = require('../../verify/checks/registry');
const { validateResearchChecks } = require('../../lib/research/reviewed-checks');

const SRC = "module.exports = async ({ require, assert }) => { assert.equal(require('./src/a.js').a, 2); };";
const AC = [{ id: 'AC-1', criterion: 'a is 2', met: null, kind: 'behavioral' }];
const v = validateResearchChecks([{ id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', params: { source: SRC } }], AC,
  { reviewed: [{ check_id: 'SC-1', source_sha256: crypto.createHash('sha256').update(SRC).digest('hex'), reviewed_by: 'fixture', ref: 'fixture' }] });
const CHECKS = v.accepted; const H = checkSetHash(CHECKS);
const contract = approve({ id: 'c', goal: 'Set a to 2', acceptance_criteria: AC, clarifying_question: null, checks: CHECKS, checks_registry: 'qb-checks/3',
  scope: { allowed_changes: ['src/**'] }, test_policy: { preexisting_failures: 'waive' } }, { via: 'test' });
const CHANGE = { file: 'src/a.js', status: 'M', additions: 1, deletions: 1, binary: false };
const DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-exports.a = 1;\n+exports.a = 2;\n';
// an advisory-passing research visible channel (so only the CHECK evidence decides the criterion)
const VER = { mode: 'research_mocha', test_plan: { runner: 'mocha' }, status: 'ran', verdict: 'passed', reasons: [],
  validation: { counts: { total: 1, passed: 1, failed: 0 }, failing: [] }, steps: [{ name: 'test', exit_code: 0 }] };
const doc = (results, o = {}) => JSON.stringify({ format: 'qb-check-results/1', complete: true, check_set_hash: H, results, ...o });
const one = { id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', status: 'pass', detail: 'scenario passed' };
async function verdictFor(resultsText, { tree = 't' } = {}) {
  const exec = await execute('task', contract, null, { agent: 'claude-code', repoPath: '/repo', runSandboxed: async () => ({
    status: 'completed', diff: DIFF, changes: [CHANGE], candidate_tree: 't',
    sandbox: { verification: VER, checks: { requested: CHECKS, check_set_hash: H, results_text: resultsText, state: 'completed', tree } } }) });
  const f = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
  try { return await verify(contract, null, exec, { repoPath: '/repo' }); } finally { f.restore(); }
}

test('control: a valid passing scenario result meets the criterion (the visible channel stays advisory)', async () => {
  const r = await verdictFor(doc([one]));
  assert.equal(r.criteria_results.find((c) => c.id === 'AC-1').met, true);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.test_outcome.trust, 'advisory');
});

test('malformed check evidence through the real verifier never yields PASS', async () => {
  for (const [why, text] of [
    ['missing', null], ['empty', doc([])], ['duplicate', doc([one, one])], ['unexpected', doc([one, { ...one, id: 'SC-9' }])],
    ['unknown status', doc([{ ...one, status: 'skipped' }])], ['incomplete', doc([one], { complete: false })],
    ['hash mismatch', doc([one], { check_set_hash: 'f'.repeat(64) })], ['malformed json', '{'],
    ['a failing check', doc([{ ...one, status: 'fail', detail: 'scenario failed' }])], ['an erroring check', doc([{ ...one, status: 'error', detail: 'timed out' }])],
    ['checks ran on another tree', [doc([one]), { tree: 'other' }]],
  ]) {
    const [t, o] = Array.isArray(text) ? text : [text, {}];
    const r = await verdictFor(t, o);
    assert.notEqual(r.verdict, 'pass', why);
    assert.notEqual(r.criteria_results.find((c) => c.id === 'AC-1').met, true, why);
  }
});
