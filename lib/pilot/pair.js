/**
 * lib/pilot/pair.js — KAN-112 (senior 10660): the paired axios-5892 engineering configuration.
 *
 *   arm A  Claude only: the existing arm-A trial (lib/pilot/arm-a.js runTrial), ONE attempt, 1,800 s coding.
 *   arm B  QB: QB's REAL repair loop (lib/qb-pipeline.js runPipeline → orchestrate → execute → runAgentSandboxed),
 *          QB-28 arm E rules: up to 3 attempts sharing the SAME 1,800 s coding allowance, QB repair feedback between
 *          attempts, the reviewed contract v4 + approved AC-4 map, the frozen research settings, memory OFF,
 *          deterministic context and verification (no local or judge model).
 * Shared: task, base, model, Claude Code version, tool/permission profile, images, the 90-min trial total, and the
 * independent grader applied to each arm's final captured bytes after coding.
 *
 * Live route: accepted ONLY when routeProblems() is empty — the paired driver bench/opus-pilot/pair.mjs, in CI, in the
 * protected paired live workflow (PAIR_LIVE=1), with the owner's SEPARATE recorded confirmation (approvals.paired_route)
 * naming this driver. The arm-A batch-1 confirmation does not extend to it. Configuration only, never proof of sign-in.
 */
const path = require('path');
const crypto = require('crypto');
const A = require('./arm-a');

const ROUTE = A.ROUTE;
const DRIVER = 'bench/opus-pilot/pair.mjs';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function routeProblems(env = process.env, argv1 = process.argv[1], { approvals = A.readApprovals() } = {}) {
  const p = [];
  if (path.basename(String(argv1 || '')) !== path.basename(DRIVER)) p.push(`the live route is only for the paired driver ${DRIVER}`);
  if (env.GITHUB_ACTIONS !== 'true' || env.PAIR_LIVE !== '1') p.push('the live route only runs in the protected paired live workflow (GITHUB_ACTIONS=true, PAIR_LIVE=1)');
  const tok = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof tok !== 'string' || !tok.length) p.push('CLAUDE_CODE_OAUTH_TOKEN is not set');
  else if (/\s/.test(tok)) p.push('CLAUDE_CODE_OAUTH_TOKEN is malformed (whitespace)');
  for (const k of A.FORBIDDEN_ENV) if (env[k]) p.push(`${k} is set (refused: it would change the billing route or provider)`);
  const a = approvals && approvals.paired_route;
  if (!a || a.route !== ROUTE || !a.confirmed_by || !a.confirmed_at || !a.residual_risk_sha256 || !Array.isArray(a.drivers) || !a.drivers.includes(DRIVER)) {
    p.push('the owner has not confirmed the paired route for this driver (bench/opus-pilot/approvals.json paired_route)');
  }
  return p;
}

function signInAdapter(env = process.env, argv1 = process.argv[1], o = {}) {
  return async () => {
    const probs = routeProblems(env, argv1, o);
    return probs.length ? { status: 'error', reasons: probs, kind: 'configuration' } : { status: 'ok', kind: 'configuration (not proof of authentication)' };
  };
}

/** The same reviewed profile for both arms (model, CLI version, permission mode, tools, route). */
function pairProfile() { return A.armAProfile(); }

const arr = (x) => (Array.isArray(x) ? x : (typeof x === 'string' && x ? JSON.parse(x) : []));
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const added = (p, min = 20) => String(p || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => norm(l.slice(1))).filter((l) => l.length >= min && /[A-Za-z]/.test(l));
/**
 * Briefing guard (every attempt, QB repair feedback included; senior 10662). Refuses, counts only:
 *   - any FAIL_TO_PASS name (added by the hidden test patch), any gold-patch line, any test-patch line;
 *   - any other grader test name (PASS_TO_PASS) UNLESS it is verified in the pinned visible suite: its identity
 *     sha256(file + NUL + name) is in the frozen visible-suite identity set for one of the env record's test files.
 * Without a visible-suite record every grader test name is refused (fail closed).
 * Returns null (ok) or a counts-only reason.
 */
function briefingGuard(vaultRow, { visible = null } = {}) {
  if (!vaultRow) return null;
  const hidden = arr(vaultRow.FAIL_TO_PASS).map(norm).filter(Boolean);
  const graderNames = arr(vaultRow.PASS_TO_PASS).map(norm).filter(Boolean);
  const ids = new Set(((visible && visible.identities) || []).map((e) => e.id));
  const files = (visible && visible.test_files) || [];
  const verified = (n) => files.some((f) => ids.has(sha(`${f}\0${n}`)));
  const lines = [...added(vaultRow.patch), ...added(vaultRow.test_patch)];
  return (briefing) => {
    const t = norm(briefing);
    const h = hidden.filter((x) => t.includes(x)).length;
    const u = graderNames.filter((x) => t.includes(x) && !verified(x)).length;
    const l = lines.filter((x) => t.includes(x)).length;
    const why = [h && `fail_to_pass names ${h}`, u && `grader test names not in the pinned visible suite ${u}`, l && `patch lines ${l}`].filter(Boolean);
    return why.length ? `hidden material in the briefing (${why.join(', ')}; counts only)` : null;
  };
}

/**
 * Smoke acceptance (senior 10662): the harmless smoke through the paired route must show COMPLETE served-model and
 * subscription/billing evidence and no overage, and must change nothing. Missing or unknown evidence is a problem.
 */
function smokeProblems(s) {
  const p = [];
  if (!s || s.primary !== 'execution_verified') p.push(`attempt not verified (${s ? s.primary : 'no record'})`);
  if (!s || s.capture_state !== 'no_change') p.push('the smoke changed files');
  const m = (s && s.model) || {};
  if (m.served !== 'claude-opus-5-5') p.push(`served model ${JSON.stringify(m.served)} is not claude-opus-5-5`);
  const b = s && s.billing_route;
  if (!b) p.push('no billing record');
  else {
    if (b.api_key_source !== 'none') p.push(`API key source ${JSON.stringify(b.api_key_source)} (subscription route requires "none")`);
    if (b.provider !== 'firstParty') p.push(`provider ${JSON.stringify(b.provider)} (requires firstParty)`);
    if (b.is_using_overage !== false) p.push(`overage ${JSON.stringify(b.is_using_overage)} (requires an explicit false)`);
  }
  return p;
}

/** Arm A of the pair: the arm-A trial, on the paired route (or the test seam). */
async function runArmA(o) {
  return A.runTrial({ ...o, route: 'paired', profile: o.profile || pairProfile(), ...(o.vaultRow ? { briefingGuard: briefingGuard(o.vaultRow, { visible: o.visible || null }) } : {}) });
}

/**
 * Arm B of the pair: QB's real repair loop. `seam` replaces runSandboxed (tests and the labelled dry run only);
 * `verifyFn` (tests only) observes verify(). Returns the pilot record, the candidate record (last attempt) and its EXACT bytes.
 */
async function runArmB(o) {
  const { pilotTrial, pilotRecord } = require('../../bench/experiment-run');
  const { runPipeline } = require('../qb-pipeline');
  const { agentFailure } = require('../../bench/arms');
  const { candidateRecord } = require('../research/candidate');
  const { createRun } = require('../../run/store');
  const P = require('../sandbox/agent-profile');
  const budget = require('../budget');
  const a = o.amendment;
  const codingMs = o.codingMsOverride || a.time.coding_s * 1000;
  const profile = o.profile || pairProfile();
  if (!o.codingMsOverride) {
    const bad = P.budgetProblem(profile, { agentTimeMs: codingMs, qb28Arm: 'E', armMaxAttempts: 3 });
    if (bad) throw new Error(`arm-B: ${bad}`);
  }
  const pilot = { amendment: a, sha256: o.amendmentSha256, scale: 1, totalMs: a.time.trial_total_s * 1000, codingMs };
  const pt = pilotTrial(pilot, { signInAdapter: o.signInAdapter });
  const br = budget.startRun({ deadlineMs: pt.totalMs, agent: 'claude-code' });
  br.signal.addEventListener('abort', () => { if (!pt.abortStage) pt.abortStage = pt.stage; });
  const t0 = Date.now();
  const run = createRun({ kind: 'bench-arm', repoPath: o.repoPath, request: o.contract.goal || '', runsDir: o.runsDir, config: { trial_id: o.trialId, arm: 'B', task_id: o.taskId }, agent: { type: 'claude-code', version: profile.claude_code_version, isolation: 'sandbox' } });
  const verify = require('../../verify/verifier').verify;
  let r = null; let out;
  pt.stage = 'arm';
  try {
    r = await runPipeline({
      contract: o.contract, repoPath: o.repoPath, agent: 'claude-code', maxRetries: 3, run, budgetRun: br, baseSha: null, memory: null,
      noLlmContext: true, noLlmVerify: true, agentTimeMs: codingMs,
      agentProfile: profile, pilot: pt.hooks,
      research: { ...o.research, deadlineAtMs: t0 + pt.totalMs }, preservationMaps: o.preservationMaps,
      ...(o.vaultRow ? { briefingGuard: briefingGuard(o.vaultRow, { visible: o.visible || null }) } : {}),
      ...(o.seam ? { runSandboxed: o.seam, approvedAuthRoutes: o.approvedAuthRoutes || [ROUTE] } : { pairedResearchRoute: true }),
      ...(o.verifyFn ? { deps: { verify: o.verifyFn } } : { deps: { verify } }),
    });
    const ex = r.execution;
    if (r.blocked) out = { status: 'agent_error', detail: String(r.blocked).slice(0, 500), patch: '' };
    else { const failed = agentFailure(ex); out = failed ? { ...failed, patch: (ex && ex.diff) || '' } : { status: 'completed', patch: (ex && ex.diff) || '' }; }
  } catch (e) {
    out = { status: 'infra_error', detail: String(e && e.message).slice(0, 500), patch: '' };
  } finally { budget.endRun(); }
  const agentMs = r ? r.agent_ms || 0 : 0;
  out.agent_ms = agentMs; out.attempts = r ? r.attempt : 0;
  pt.clock.debitCoding(agentMs); pt.stage = 'grading';
  const slot = { trial_id: o.trialId, task_id: o.taskId, repetition: 1, arm: 'B' };
  const pilotRec = pilotRecord(pt, out, null, slot, pilot);
  const ex = r && r.execution;
  const cand = candidateRecord(ex || { status: out.status }, { label: o.label || 'pair-b', env: { task_id: o.taskId }, qbCommit: o.qbCommit || null, graderTask: o.graderTask || null });
  const patch = ex && ex.patch_raw ? Buffer.from(ex.patch_raw) : Buffer.alloc(0);
  return {
    pilot: pilotRec, candidate: cand, patch, blocked: r ? r.blocked || null : null,
    attempts: out.attempts, agent_ms: agentMs, timing: r ? r.timing : [], internal_verdict: r && r.report ? r.report.verdict : null,
    attempt_verdicts: r ? (r.attemptHistory || []).map((h) => ({ attempt: h.attempt, verdict: h.verdict })) : [],
    // diagnostics (statuses and reasons only; never test titles, diff or task text)
    last_report: r && r.report ? { verdict: r.report.verdict, test_outcome: r.report.test_outcome ? { outcome: r.report.test_outcome.outcome, reason: r.report.test_outcome.reason } : null,
      criteria: (r.report.criteria_results || []).map((c) => `${c.id}:${c.met}`), failures: (r.report.failures || r.report.verdict_failures || []).slice(0, 8).map((f) => String(f.rule || f.reason || f).slice(0, 120)),
      checks: r.execution && r.execution.sandbox && r.execution.sandbox.checks ? { state: r.execution.sandbox.checks.state, error: r.execution.sandbox.checks.error || null } : null,
      verification: r.execution && r.execution.sandbox && r.execution.sandbox.verification ? { status: r.execution.sandbox.verification.status, verdict: r.execution.sandbox.verification.verdict, reason: r.execution.sandbox.verification.reason || null, reasons: (r.execution.sandbox.verification.reasons || []).slice(0, 8) } : null,
      scope_violations: (r.report.scope_violations || []).length } : null,

    grade_now: cand.gradable && pilotRec.patch_use === 'grade_under_10583' && patch.length > 0,
    stop_batch: ['usage_limit', 'auth_timeout', 'policy_violation'].includes(pilotRec.primary) || (pilotRec.flags || []).some((f) => ['usage_limit', 'auth_timeout'].includes(f)),
    wall_ms: Date.now() - t0, profile: { ...profile }, coding_ms: codingMs, total_ms: pt.totalMs, run_dir: run.dir || null,
  };
}

module.exports = { ROUTE, DRIVER, routeProblems, signInAdapter, pairProfile, briefingGuard, smokeProblems, runArmA, runArmB, sha };
