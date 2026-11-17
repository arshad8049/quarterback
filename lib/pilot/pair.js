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
  const res = await A.runTrial({ ...o, route: 'paired', profile: o.profile || pairProfile(), ...(o.vaultRow ? { briefingGuard: briefingGuard(o.vaultRow, { visible: o.visible || null }) } : {}) });
  return applyEvidence(res, res.pilot_attempts, 1, null, o);
}

// ── KAN-114 10689 (freeze v7): per-attempt evidence, classified on EVERY attempt, for both arms ──
const OK_OUTCOMES = ['verified', 'coding_timeout'];
const str = (v) => (typeof v === 'string' ? v : null);
/** Sanitized per-attempt evidence entries from the trial's pilot records (host-failure records excluded). */
function attemptEvidence(records) {
  return (records || []).filter((x) => x && !x.host_failure).map((x, i) => {
    const rep = x.report || {}; const m = rep.model || {}; const b = rep.billing_route || {};
    const u = rep.usage || {}; const n = (v) => (Number.isInteger(v) ? v : null);
    return {
      attempt: Number.isInteger(x.attempt) ? x.attempt : null, record_index: i,
      outcome: str(x.outcome) || (Array.isArray(x.flags) && x.flags[0]) || 'unknown', flags: Array.isArray(x.flags) ? [...x.flags] : [],
      reasons: (x.reasons || []).slice(0, 8).map((r) => String(r).slice(0, 200)), evidence_complete: x.evidence_complete === true,
      requested_model: str(m.requested), served_model: str(m.served), served_unobservable: m.served && typeof m.served === 'object' ? str(m.served.unobservable) || 'unavailable' : null,
      cli: str(rep.claude_code_version), provider: str(b.provider), api_key_source: str(b.api_key_source),
      is_using_overage: typeof b.is_using_overage === 'boolean' ? b.is_using_overage : null, overage_status: str(b.overage_status),
      sandbox_state: str(x.sandbox_state), agent_stage_ms: Number.isFinite(x.agent_stage_ms) ? x.agent_stage_ms : null,
      patch_sha256: str(x.patch_sha256), stdout_dropped: Number.isInteger(x.stdout_dropped) ? x.stdout_dropped : null,
      tokens: { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_tokens), cache_write: n(u.cache_write_tokens), reasoning: n(u.reasoning_tokens) },
    };
  });
}
/**
 * Why the per-attempt evidence does NOT verify the trial ([] = verified). Uses only what each attempt's own stream
 * reported; the configured profile is the expectation, never the evidence.
 */
function evidenceProblems(entries, profile, attemptsRun) {
  const p = [];
  const es = Array.isArray(entries) ? entries : [];
  if (!es.length) return ['no per-attempt evidence (the configured profile alone is not evidence)'];
  // KAN-114 10693 (v8): EXACTLY one entry per executed attempt, ids 1..n unique and in order, valid patch hashes
  if (!Number.isInteger(attemptsRun) || attemptsRun < 1) p.push(`executed attempt count ${JSON.stringify(attemptsRun)} is not a positive integer`);
  else if (es.length !== attemptsRun) p.push(`${es.length} evidence entr${es.length === 1 ? 'y' : 'ies'} for ${attemptsRun} executed attempt(s) (exactly one per attempt required)`);
  const ids = es.map((e) => e.attempt);
  if (!ids.every((id, i) => id === i + 1)) p.push(`attempt ids ${JSON.stringify(ids)} are not unique and ordered 1..${es.length}`);
  es.forEach((e, i) => {
    const at = `attempt ${Number.isInteger(e.attempt) ? e.attempt : i + 1}`;
    if (e.patch_sha256 !== null && !/^[0-9a-f]{64}$/.test(String(e.patch_sha256))) p.push(`${at}: patch hash ${JSON.stringify(e.patch_sha256)} is not a sha256 (or null for no patch)`);
    if (!OK_OUTCOMES.includes(e.outcome)) p.push(`${at}: outcome ${e.outcome || 'unknown'}${e.reasons && e.reasons.length ? ` (${e.reasons.join('; ')})` : ''}`);
    if (e.evidence_complete !== true) p.push(`${at}: evidence incomplete`);
    if (e.served_model !== profile.model) p.push(`${at}: served model ${JSON.stringify(e.served_model)} is not ${profile.model}`);
    if (e.requested_model !== profile.model) p.push(`${at}: requested model ${JSON.stringify(e.requested_model)} is not ${profile.model}`);
    if (e.cli !== profile.claude_code_version) p.push(`${at}: Claude Code ${JSON.stringify(e.cli)} is not ${profile.claude_code_version}`);
    if (e.api_key_source !== 'none') p.push(`${at}: API key source ${JSON.stringify(e.api_key_source)} (requires "none")`);
    if (e.provider !== 'firstParty') p.push(`${at}: provider ${JSON.stringify(e.provider)} (requires firstParty)`);
    if (e.is_using_overage !== false) p.push(`${at}: overage ${JSON.stringify(e.is_using_overage)} (requires an explicit false)`);
  });
  return p;
}
const EMPTY_SHA = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
/**
 * KAN-114 10693 (v8): checked patch linkage. The final attempt's patch hash, the candidate hash and the sha256 of the
 * ACTUAL captured bytes in hand must all agree. Stored hash fields alone are not linkage: without the bytes it fails.
 */
function linkageProblems(rec, patchBytes) {
  const p = [];
  const es = Array.isArray(rec && rec.attempt_evidence) ? rec.attempt_evidence : [];
  const cand = (rec && rec.candidate) || {};
  const last = es[es.length - 1];
  if (last && (last.patch_sha256 || EMPTY_SHA) !== cand.sha256) p.push('final attempt patch hash differs from the candidate hash');
  if (!Buffer.isBuffer(patchBytes)) p.push('captured bytes not supplied (stored hash fields alone are not linkage)');
  else {
    if (crypto.createHash('sha256').update(patchBytes).digest('hex') !== cand.sha256) p.push('candidate hash differs from the sha256 of the captured bytes');
    if (patchBytes.length !== cand.bytes) p.push('candidate byte count differs from the captured bytes');
  }
  return p;
}
/** Attach the evidence to an arm result; unverified evidence can never leave the trial execution_verified. */
function applyEvidence(res, records, attemptsRun, evidenceStopped, o) {
  const entries = attemptEvidence(records);
  const problems = evidenceProblems(entries, res.profile, attemptsRun);
  const verified = problems.length === 0;
  const pilot = { ...res.pilot };
  if (!verified) {
    // KAN-114 10693 (v8): for EVERY primary (coding_timeout and infra classifications included) missing/invalid evidence
    // removes verified-comparison grading eligibility; only execution_verified is relabelled, others keep their class
    if (pilot.primary === 'execution_verified') {
      pilot.primary = 'incomplete_evidence';
      pilot.flags = [...new Set([...(pilot.flags || []).filter((f) => f !== 'execution_verified'), 'incomplete_evidence'])].sort();
    } else pilot.flags = [...new Set([...(pilot.flags || []), 'evidence_unverified'])].sort();
    pilot.reasons = [...(pilot.reasons || []), ...problems].slice(0, 20);
    pilot.execution_evidence = 'not_verified'; pilot.valid_completed_trial = false;
    if (pilot.patch_use === 'grade_under_10583') pilot.patch_use = 'diagnostic_only';
  } else pilot.execution_evidence = 'verified';
  const last = verified ? entries[entries.length - 1] : null;
  const live = o && o.liveEvidenceGate !== undefined ? o.liveEvidenceGate === true : !(o && o.seam);
  return { ...res, pilot, attempt_evidence: entries, evidence: { verified, problems: problems.slice(0, 20), basis: 'each attempt\'s own stream (classifyAttempt); never the configured profile' },
    evidence_stopped: evidenceStopped || res.evidence_stopped || null,
    // the top-level model/billing view exists ONLY when every attempt verified (all agree on the served model by then)
    agent_report: last ? { model: { requested: last.requested_model, served: last.served_model }, billing_route: { api_key_source: last.api_key_source, provider: last.provider,
      is_using_overage: last.is_using_overage, overage_status: last.overage_status }, claude_code_version: last.cli } : null,
    grade_now: Boolean(res.grade_now && pilot.patch_use === 'grade_under_10583'),
    stop_batch: Boolean(res.stop_batch || (live && !verified)) };
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
  return applyEvidence({
    pilot: pilotRec, candidate: cand, patch, blocked: r ? r.blocked || null : null,
    attempts: out.attempts, agent_ms: agentMs, timing: r ? r.timing : [], internal_verdict: r && r.report ? r.report.verdict : null,
    attempt_verdicts: r ? (r.attemptHistory || []).map((h) => ({ attempt: h.attempt, verdict: h.verdict })) : [],
    // diagnostics (statuses and reasons only; never test titles, diff or task text)
    last_report: r && r.report ? { verdict: r.report.verdict,
      criteria: (r.report.criteria_results || []).map((c) => `${c.id}:${c.met}`), failures: (r.report.failures || r.report.verdict_failures || []).slice(0, 8).map((f) => String(f.rule || f.reason || f).slice(0, 120)),
      checks: r.execution && r.execution.sandbox && r.execution.sandbox.checks ? { state: r.execution.sandbox.checks.state, error: r.execution.sandbox.checks.error || null } : null,
      // KAN-114 10689: the RAW research-channel verdict (any failing visible test, base failures included) and the
      // POLICY-ADJUSTED outcome (frozen exceptions / isolation re-checks applied; verify/research-adapter.js) are separate
      raw_channel_verification: r.execution && r.execution.sandbox && r.execution.sandbox.verification ? { status: r.execution.sandbox.verification.status, verdict: r.execution.sandbox.verification.verdict,
        reason: r.execution.sandbox.verification.reason || null, reasons: (r.execution.sandbox.verification.reasons || []).slice(0, 8),
        counts: r.execution.sandbox.verification.validation && r.execution.sandbox.verification.validation.counts ? { ...r.execution.sandbox.verification.validation.counts } : null } : null,
      policy_adjusted_test_outcome: r.report.test_outcome ? { outcome: r.report.test_outcome.outcome, reason: r.report.test_outcome.reason,
        regressions: Number.isInteger(r.report.test_outcome.regressions_total) ? r.report.test_outcome.regressions_total : (r.report.test_outcome.regressions || []).length,
        frozen_exceptions: Number.isInteger(r.report.test_outcome.preexisting_total) ? r.report.test_outcome.preexisting_total : (r.report.test_outcome.preexisting || []).length,
        isolation_qualified: (r.report.test_outcome.isolation_qualified || []).length, preexisting_policy: r.report.test_outcome.preexisting_policy || null } : null,
      scope_violations: (r.report.scope_violations || []).length } : null,

    grade_now: cand.gradable && pilotRec.patch_use === 'grade_under_10583' && patch.length > 0,
    stop_batch: ['usage_limit', 'auth_timeout', 'policy_violation'].includes(pilotRec.primary) || (pilotRec.flags || []).some((f) => ['usage_limit', 'auth_timeout'].includes(f)),
    wall_ms: Date.now() - t0, profile: { ...profile }, coding_ms: codingMs, total_ms: pt.totalMs, run_dir: run.dir || null,
  }, pt.attempts, out.attempts, r ? r.evidence_stopped || null : null, o);
}

/**
 * KAN-114 10689 (v7): the durable sanitized trial record (moved here from bench/opus-pilot/pair.mjs so the production
 * assembly is testable). `ctx` carries what only the driver knows (mode, freeze, images, launches, probes).
 */
function pairSummary(res, ctx) {
  const rep = res.agent_report || null;
  return {
    schema: 'qb-pair-trial/2', freeze: ctx.freeze, arm: ctx.arm, mode: ctx.mode, dry_run: !ctx.live, task: ctx.task, task_id: ctx.taskId,
    evidence_label: ctx.live ? 'live trial' : ctx.simulated ? 'SIMULATED: fake stream behind the test seam; not a live model or billing check'
      : 'DRY RUN: scripted agent stage; no model, no token; not a live model or billing check',
    qb_commit: ctx.qbCommit || null, run_id: ctx.runId || null,
    primary: res.pilot.primary, flags: res.pilot.flags, reasons: res.pilot.reasons, patch_use: res.pilot.patch_use, valid_completed_trial: res.pilot.valid_completed_trial,
    coding_ms: res.pilot.effort ? res.pilot.effort.coding_ms : null, total_elapsed_ms: res.pilot.effort ? res.pilot.effort.total_elapsed_ms : null,
    coding_allowance_ms: res.coding_ms, total_allowance_ms: res.total_ms,
    attempts: ctx.arm === 'A' ? 1 : res.attempts, attempt_verdicts: res.attempt_verdicts || null, timing: res.timing || null, internal_verdict: res.internal_verdict ?? null,
    // derived ONLY from verified per-attempt evidence (null otherwise); never from profile.model
    model: rep ? rep.model : null, billing_route: rep ? rep.billing_route : null, cli: res.profile.claude_code_version, profile: res.profile,
    attempt_evidence: res.attempt_evidence || [], evidence: res.evidence || { verified: false, problems: ['no evidence record'] }, evidence_stopped: res.evidence_stopped || null,
    candidate: { sha256: res.candidate.sha256, bytes: res.candidate.bytes, gradable: res.candidate.gradable, not_gradable_reason: res.candidate.not_gradable_reason,
      files: res.candidate.files, base_tree: res.candidate.base_tree, candidate_tree: res.candidate.candidate_tree },
    coding_isolation_probe: ctx.probes || [], stop_batch: res.stop_batch,
    grade_now: ctx.live ? res.grade_now : Boolean(res.candidate.gradable && res.patch && res.patch.length > 0), grade_basis: ctx.live ? 'pilot rule (grade_under_10583)' : 'dry-run exercise of the grading path',
    pilot_grade_now: res.grade_now,
    diagnostics: { sandbox: res.sandbox || null, attempt_outcome: res.attempt_outcome || null, attempt_reasons: res.attempt_reasons || null, last_report: res.last_report || null },
    images: ctx.images || [], launches: ctx.launches || 0, distinct_launch_images: ctx.distinctImages || [],
  };
}

/**
 * Readback gate on a SERIALIZED trial record: why it does not establish a verified trial ([] = it does).
 * v8: with `patchBytes` the final-attempt/candidate/captured-bytes linkage is checked; without them linkage fails.
 */
function recordProblems(rec, { patchBytes } = {}) {
  if (!rec || typeof rec !== 'object') return ['no record'];
  const prof = rec.profile || {};
  const p = evidenceProblems(rec.attempt_evidence, { model: prof.model, claude_code_version: prof.claude_code_version }, rec.attempts);
  const evOk = p.length === 0;
  if (rec.primary === 'execution_verified' && !evOk) p.push('record says execution_verified without verified per-attempt evidence');
  if (!rec.evidence || rec.evidence.verified !== evOk) p.push('record evidence.verified disagrees with its per-attempt entries');
  if (evOk && (!rec.model || rec.model.served !== prof.model || !rec.billing_route)) p.push('top-level model/billing view missing despite verified attempts');
  if (!evOk && (rec.valid_completed_trial === true || rec.patch_use === 'grade_under_10583')) p.push('record keeps grading eligibility without verified evidence');
  p.push(...linkageProblems(rec, patchBytes));
  return [...new Set(p)];
}

const LIVE_MODES = ['task', 'smoke'];
/**
 * KAN-114 10693 (v8): the driver's exit decision, made on the PUBLISHED (serialized) record and the captured bytes.
 *  - live (task / smoke): any readback problem, or a record not labelled as a live trial of this mode, is a nonzero
 *    refusal (8) and the record is not grade-eligible; otherwise the existing exit applies (`code: null` for smoke so
 *    its acceptance check runs on the same readback, 5 on a batch stop, else 0).
 *  - dry-run / smoke-dry: a scripted stage has no stream, so the record MUST stay unverified (expected); a dry record
 *    that verifies, a live label, or broken byte linkage is a failure (9). Dry results never stand in for live ones.
 * The returned sidecar preserves sanitized diagnostics; it never calls a refused record a verified artifact.
 */
function readbackGate({ mode, record, patchBytes, stopBatch }) {
  const live = LIVE_MODES.includes(mode);
  const problems = recordProblems(record, { patchBytes });
  const linkage = linkageProblems(record || {}, patchBytes);
  const label = record && record.evidence_label;
  let code; let expectation;
  if (live) {
    if (label !== 'live trial' || !record || record.dry_run !== false || record.mode !== mode) problems.push(`not a live record for mode ${mode} (label ${JSON.stringify(label)})`);
    if (problems.length) { code = 8; expectation = 'live: refused on the serialized readback'; }
    else { code = mode === 'smoke' ? null : (stopBatch ? 5 : 0); expectation = 'live: readback verified'; }
  } else {
    const fail = [];
    if (problems.length === 0) fail.push('a scripted dry-run record verified (it has no model stream; it must not masquerade as live evidence)');
    if (label === 'live trial' || (record && record.dry_run !== true)) fail.push('dry record carries a live label');
    fail.push(...linkage);
    if (fail.length) { problems.push(...fail); code = 9; expectation = 'dry: expectation violated'; }
    else { code = mode === 'smoke-dry' ? null : 0; expectation = 'dry: unverified as expected (scripted stage, no stream)'; }
  }
  const verified = live && code !== 8;
  const uniq = [...new Set(problems)];
  return { code, verified, problems: uniq, expectation,
    sidecar: { schema: 'qb-pair-readback/1', mode, arm: record ? record.arm : null, evidence_label: label || null, verified_artifact: verified,
      grade_eligible: verified && Boolean(record && record.grade_now), expectation, problems: uniq.slice(0, 20) } };
}

module.exports = { ROUTE, DRIVER, pairSummary, recordProblems, readbackGate, linkageProblems, applyEvidence, attemptEvidence, evidenceProblems, routeProblems, signInAdapter, pairProfile, briefingGuard, smokeProblems, runArmA, runArmB, sha };
