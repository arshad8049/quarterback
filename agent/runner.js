const { randomUUID } = require('crypto');
const { contractState, stateReason, approvalState } = require('../intent/contract-state');
const { ExecutionResultSchema } = require('./schema');
const { runSandboxed } = require('../lib/sandbox/pipeline');

/**
 * Execute the briefing against a coding agent (or dry-run).
 *
 * The coding agent runs only inside the QB sandbox (QB-02, docs/security/
 * agent-sandbox.md): a disposable workspace seeded from a read-only copy of the
 * checkout, no network except the inference proxy, changes captured by trusted
 * code. There is no host-execution path and no environment variable or flag
 * that selects one.
 *
 * @param {string} briefing    - Markdown Agent Briefing from briefing.js
 * @param {object} contract    - TaskContract (for IDs)
 * @param {object|null} context - ContextPackage (for IDs + repo path)
 * @param {object} options     - { agent: 'dry-run'|'claude-code'|'manual', repoPath: string, timeoutMs?: number,
 *                                runSandboxed?: Function (injected by tests only) }
 * @returns {object}           - Validated ExecutionResult
 */
async function execute(briefing, contract, context, options = {}) {
  const agent  = options.agent    || 'dry-run';
  const repo   = options.repoPath || (context?.repo_path) || process.cwd();

  const t0 = Date.now();
  let outcome = {
    status: 'dry_run', diff: null, changes: [], unsupported_changes: [],
    base_tree: null, candidate_tree: null,
    exit_code: null, signal: null, stderr_tail: null, error: null,
  };

  // Only a finalized (QB-08), human-approved and unchanged (QB-13) contract may reach an agent.
  const gate = executionGate(contract, { agent, exploration: options.unapprovedExploration === true });
  if (gate) {
    outcome = { ...outcome, status: 'blocked', error: gate };
  } else if (agent === 'claude-code') {
    // The relevant files, exported from the tested tree if the agent changes nothing (QB-22).
    const snapshotPaths = (context?.relevant_files || []).map(f => (typeof f === 'string' ? f : f?.path)).filter(p => typeof p === 'string' && p);
    // QB-16: only registry-accepted checks reach the sandbox; they are not in the briefing.
    outcome = await runAgentSandboxed(briefing, repo, { ...options, snapshotPaths, checks: Array.isArray(contract.checks) ? contract.checks : [] });
  } else if (agent === 'manual') {
    // Print briefing and wait for the dev to run their agent
    process.stdout.write('\n' + briefing + '\n');
  }
  // dry-run: no invocation, just return the briefing

  const result = ExecutionResultSchema.parse({
    id:           randomUUID(),
    contract_id:  contract.id  || 'unknown',
    context_id:   context?.id  || null,
    agent_used:   agent,
    duration_ms:  Date.now() - t0,
    generated_at: new Date().toISOString(),
    briefing,
    ...outcome,
  });
  // Raw patch bytes and the base listing travel alongside the record, not in it
  // (not JSON, and never redacted): qb.js stores them as binary artifacts for `qb patch`.
  for (const k of ['patch_raw', 'base_listing']) {
    if (outcome[k]) Object.defineProperty(result, k, { value: outcome[k], enumerable: false });
  }
  return result;
}

/**
 * Run the coding agent in the sandbox against `repoPath` (read-only) and return
 * the ExecutionResult fields. `options.runSandboxed` is a test seam only.
 */
async function runAgentSandboxed(briefing, repoPath, options = {}) {
  const run = options.runSandboxed || runSandboxed;
  // KAN-113 pilot: preflight BEFORE any sandbox, credential copy or pre-run refresh call. The test-only route list is
  // honoured only together with an injected sandbox stand-in, so production can never widen the approved routes.
  const profile = options.agentProfile || null;
  if (profile) {
    const P = require('../lib/sandbox/agent-profile');
    const { CLAUDE_VERSION } = require('../lib/sandbox/agent');
    const approved = options.runSandboxed && Array.isArray(options.approvedAuthRoutes) ? options.approvedAuthRoutes : P.APPROVED_AUTH_ROUTES;
    const errs = P.checkProfile(profile, { imagePin: CLAUDE_VERSION, approved });
    if (errs.length) {
      return { status: 'blocked', diff: null, changes: [], unsupported_changes: [], base_tree: null, candidate_tree: null, exit_code: null, signal: null,
        stderr_tail: null, patch_raw: null, base_listing: null, error: `pilot preflight: ${errs.join('; ')}`, sandbox: null, pilot_outcome: 'preflight_refused' };
    }
  }
  const r = await run({
    repoPath, briefing,
    ...(profile ? { requireMemoryCheck: true, agentArgs: require('../lib/sandbox/agent-profile').buildAgentArgs(profile), agentStdoutMaxBytes: require('../lib/sandbox/agent-profile').AGENT_STDOUT_MAX_BYTES } : {}),
    deadlines: options.timeoutMs ? { agent: options.timeoutMs } : undefined,
    snapshotPaths: options.snapshotPaths,
    checks: options.checks,
    signal: options.signal,          // QB-21: the run's cancellation (total-run deadline)
  });
  const { status, diff = null, changes = [], unsupported_changes = [], base_tree = null, candidate_tree = null,
    exit_code = null, signal = null, stderr_tail = null, sandbox = null, patch_raw = null, base_listing = null } = r;
  const out = {
    status, diff, changes, unsupported_changes, base_tree, candidate_tree, exit_code, signal, stderr_tail,
    patch_raw, base_listing,
    error: ['completed', 'no_change'].includes(status) ? null : (r.reason || r.error || status),
    sandbox,
  };
  if (profile && ['completed', 'no_change', 'timeout'].includes(status)) {
    // KAN-113 (10589): classify from Claude Code's own report; distinct outcomes; a coding timeout keeps its status and patch.
    const agentState = r.sandbox && r.sandbox.stages && r.sandbox.stages.agent ? r.sandbox.stages.agent.state : status;
    const c = require('../lib/sandbox/agent-profile').classifyAttempt({ stdout: r.agent_stdout, dropped: r.agent_stdout_dropped || 0, sandboxState: agentState }, profile);
    out.agent_report = c.report; out.pilot_outcome = c.outcome; out.pilot_evidence_complete = c.evidence_complete; out.pilot_reasons = c.reasons;
    if (!['verified', 'coding_timeout'].includes(c.outcome)) { out.status = 'infra_error'; out.error = `pilot ${c.outcome}: ${c.reasons.join('; ')}`; }
  }
  return out;
}

/**
 * The shared execution boundary (QB-08, QB-13): why a contract may NOT reach an
 * agent, or null. Every path that can run an agent calls this — the root CLI,
 * the standalone agent CLI, the benchmark's QB arm and its baseline arm.
 *   - the contract must be finalized;
 *   - unless this is a dry run, it must carry a current human approval (a change
 *     after approval voids it);
 *   - `exploration` is the only exception: an explicit, recorded mode whose runs
 *     can never PASS (the verdict needs the same approval).
 */
function executionGate(contract, { agent = 'dry-run', exploration = false } = {}) {
  const cs = contractState(contract);
  if (cs.state !== 'finalized') return `contract ${stateReason(cs)}`;
  if (agent === 'dry-run' || exploration) return null;
  const ap = approvalState(contract);
  return ap.approved ? null : `contract not approved: ${ap.reason}`;
}

module.exports = { execute, runAgentSandboxed, executionGate };
