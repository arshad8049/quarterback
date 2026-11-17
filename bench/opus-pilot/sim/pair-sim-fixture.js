'use strict';
/**
 * KAN-114 10693 (freeze v8): the SIMULATED paired-trial fixture shared by the unit tests and the no-secret CI
 * rehearsal (bench/opus-pilot/sim/pair-sim.mjs). A fake Claude stream-json behind the runSandboxed seam: no Docker,
 * model, network or token. Everything produced from it is labelled SIMULATED and can never pass a LIVE readback gate
 * (lib/pilot/pair.js readbackGate refuses a non-live label in a live mode).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const amendBytes = fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/amendments/amendment-1.json'));
const amendment = JSON.parse(amendBytes);
const MODEL = 'claude-opus-5-5';

/** A simulated stream-json; each knob breaks exactly one piece of evidence. */
function stream({ model = MODEL, initModel = model, version = '2.1.322', apiKeySource = 'none', overage = false, rate = true, result = true, init = true } = {}) {
  return [
    ...(init ? [{ type: 'system', subtype: 'init', claude_code_version: version, model: initModel, apiKeySource, permissionMode: 'dontAsk', tools: [] }] : []),
    { type: 'assistant', message: { model, content: [{ type: 'text', text: 'done' }] } },
    ...(rate ? [{ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', overageStatus: 'disabled', status: 'allowed', isUsingOverage: overage } }] : []),
    ...(result ? [{ type: 'result', subtype: 'success', is_error: false, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, provider: 'firstParty' } } }] : []),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const patchN = (n) => `diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-a\n+b${n}\n`;

/** fake sandbox: attempt n gets streams[n-1] (or a valid stream); QB verification fails until passOn */
function fakeSandbox(calls, { streams = [], dropped = [], passOn = 99, agentMs = 300_000, status = 'completed' } = {}) {
  const { checkSetHash } = require(path.join(ROOT, 'verify/checks/registry'));
  return async (opts) => {
    calls.push(opts);
    const n = calls.length; const P = patchN(n);
    return { status, diff: P, changes: [{ file: 'lib/x.js', status: 'M', additions: 1, deletions: 1, binary: false }], unsupported_changes: [],
      base_tree: 'b'.repeat(40), candidate_tree: `t${n}`, exit_code: 0, signal: null, stderr_tail: null, patch_raw: Buffer.from(P),
      agent_stdout: streams[n - 1] !== undefined ? streams[n - 1] : stream(), agent_stdout_dropped: dropped[n - 1] || 0,
      sandbox: { credential_mode: 'K', stages: { agent: { state: status === 'timeout' ? 'timeout' : 'completed', duration_ms: agentMs } }, capture: { verdict: { state: 'captured' } },
        verification: { mode: 'research_mocha', status: 'ran', verdict: 'passed', reasons: [], validation: { counts: { total: 1, passed: 1, failed: 0 }, identities: [], failing: [] }, steps: [{ name: 'test', exit_code: 0 }],
          prep: { status: 'ready', tree: `t${n}` }, task_base_commit: 'b'.repeat(40), protected: [':(glob)test/**'] },
        checks: { requested: opts.checks, check_set_hash: checkSetHash(opts.checks), state: 'completed', tree: `t${n}`,
          results_text: JSON.stringify({ format: 'qb-check-results/1', complete: true, check_set_hash: checkSetHash(opts.checks),
            results: opts.checks.map((c) => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter, status: n >= passOn ? 'pass' : 'fail', detail: n >= passOn ? 'ok' : 'scenario failed' })) }) } } };
  };
}

function contractFixture() {
  const { approve } = require(path.join(ROOT, 'intent/contract-state'));
  const { validateResearchChecks } = require(path.join(ROOT, 'lib/research/reviewed-checks'));
  const SRC = "module.exports = async ({ require, assert }) => { assert.ok(require('./lib/x.js')); };";
  const AC = [{ id: 'AC-1', criterion: 'x works', met: null, kind: 'behavioral', requirement_ids: ['R-1'] }];
  const CHECKS = validateResearchChecks([{ id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', params: { source: SRC } }], AC,
    { reviewed: [{ check_id: 'SC-1', source_sha256: sha(SRC), reviewed_by: 'fixture', ref: 'fixture' }] }).accepted;
  return approve({ id: 'c', goal: 'make x work', raw_request: 'make x work', requirements: [{ id: 'R-1', quote: 'make x work' }], acceptance_criteria: AC, clarifying_question: null, checks: CHECKS, checks_registry: 'qb-checks/3',
    scope: { allowed_changes: ['lib/**'] }, test_policy: { preexisting_failures: 'waive' } }, { via: 'test' });
}
const research = { env: { task_id: 'qbt_x', key: 'axios-x' }, rootScripts: [{ key: 'axios-x' }], checkRunner: { path: '/opt/qb-research/qb-check-runner.mjs', sha256: 'e'.repeat(64) } };
function repo() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pairsim-')); fs.writeFileSync(path.join(d, 'README.md'), 'x\n'); return d; }
const baseB = (extra) => ({ contract: contractFixture(), repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }), approvedAuthRoutes: ['subscription_token_env'],
  research, preservationMaps: [], trialId: 't1', taskId: 'qbt_x', graderTask: 'axios-x', runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pairsim-runs-')), ...extra });
const armASeam = (knobs = {}) => async () => ({ status: knobs.status || 'completed', diff: patchN(1), changes: [{ file: 'lib/x.js', status: 'M', additions: 1, deletions: 1, binary: false }], unsupported_changes: [], base_tree: 'b'.repeat(40), candidate_tree: 't1',
  exit_code: 0, signal: null, stderr_tail: null, patch_raw: Buffer.from(patchN(1)), agent_stdout: knobs.stdout !== undefined ? knobs.stdout : stream(), agent_stdout_dropped: 0,
  sandbox: { credential_mode: 'K', stages: { agent: { state: knobs.status === 'timeout' ? 'timeout' : 'completed', duration_ms: 1000 } }, capture: { verdict: { state: 'captured' } } } });
const baseA = (extra) => ({ briefing: 'Fix it.\n', repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }),
  research: { rootScripts: research.rootScripts }, label: 'pair-a-dry', trialId: 't', taskId: 'qbt_x', graderTask: 'axios-x', ...extra });
const SIM_CTX = { mode: 'task', live: false, simulated: true, freeze: 'pair-5892-freeze-v8', task: 'axios-x', taskId: 'qbt_x' };

module.exports = { MODEL, sha, amendment, stream, patchN, fakeSandbox, contractFixture, research, repo, baseA, baseB, armASeam, SIM_CTX };
