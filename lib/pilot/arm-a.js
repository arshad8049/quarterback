/**
 * lib/pilot/arm-a.js — the Claude-only exploratory arm (arm A, batch 1; owner plan 2026-11-14).
 *
 * Briefing: the dataset's own task text (KAN-110 agent store, leak-redacted) + QB's reviewed arm-A line
 * NATIVE_NOTE, exactly as bench/arms.js nativeArm builds it for arm A (`${prompt}\n\n${NATIVE_NOTE}\n`).
 * Grading material is used here only for the leak check (counts, never text).
 *
 * Live route `subscription_token_env` (KAN-113): accepted ONLY when every condition in liveRouteProblems()
 * holds — the research driver bench/opus-pilot/arm-a.mjs, in CI, in the protected live workflow, with the
 * owner's recorded confirmation in bench/opus-pilot/approvals.json. APPROVED_AUTH_ROUTES (agent-profile.js)
 * stays empty, so ordinary QB runs and experiment-run never accept it. An env check establishes configuration,
 * not successful authentication: only the smoke's served model and billing evidence do that.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NATIVE_NOTE } = require('../../bench/arms');
const { leakCheck } = require('../research/agent-bundle');

const ROUTE = 'subscription_token_env';
const APPROVALS = path.join(__dirname, '..', '..', 'bench', 'opus-pilot', 'approvals.json');
// Any of these would route billing away from the subscription or to another provider
const FORBIDDEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_VERTEX_PROJECT_ID'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The exact arm-A briefing; throws (counts only) if it carries a hidden test name or gold/test-patch line. */
function armABriefing(agentRow, vaultRow) {
  if (!agentRow || typeof agentRow.problem_statement !== 'string' || !agentRow.problem_statement.trim()) throw new Error('arm-A briefing: problem_statement missing from the agent store');
  const extra = Object.keys(agentRow).filter((k) => !['task_id', 'problem_statement'].includes(k));
  if (extra.length) throw new Error(`arm-A briefing: unexpected agent-store fields (${extra.join(', ')})`);
  const briefing = `${agentRow.problem_statement}\n\n${NATIVE_NOTE}\n`;
  const leaks = leakCheck(briefing, vaultRow);
  if (Object.keys(leaks).length) throw new Error(`arm-A briefing: leak check failed: ${Object.entries(leaks).map(([k, n]) => `${k}×${n}`).join(', ')}`);
  return { briefing, sha256: sha(briefing), fields_shown: ['problem_statement'], note: 'bench/arms.js NATIVE_NOTE (arm A)', leak_findings: 0 };
}

function readApprovals(file = APPROVALS) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** Why the live route may NOT be used now ([] = may be used). Configuration only, never proof of authentication. */
function liveRouteProblems(env = process.env, argv1 = process.argv[1], { approvals = readApprovals() } = {}) {
  const p = [];
  if (path.basename(String(argv1 || '')) !== 'arm-a.mjs') p.push('the live route is only for the research driver bench/opus-pilot/arm-a.mjs');
  if (env.GITHUB_ACTIONS !== 'true' || env.ARM_A_LIVE !== '1') p.push('the live route only runs in the protected arm-A live workflow (GITHUB_ACTIONS=true, ARM_A_LIVE=1)');
  const tok = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof tok !== 'string' || !tok.length) p.push('CLAUDE_CODE_OAUTH_TOKEN is not set');
  else if (/\s/.test(tok)) p.push('CLAUDE_CODE_OAUTH_TOKEN is malformed (whitespace)');
  for (const k of FORBIDDEN_ENV) if (env[k]) p.push(`${k} is set (refused: it would change the billing route or provider)`);
  const a = approvals && approvals.auth_route;
  if (!a || a.route !== ROUTE || !a.confirmed_by || !a.confirmed_at || !a.residual_risk_sha256) p.push('the owner has not confirmed the exact route and residual risk (bench/opus-pilot/approvals.json auth_route)');
  return p;
}

/** The per-attempt sign-in adapter for the pilot hook: a no-network configuration check. */
function signInAdapter(env = process.env, argv1 = process.argv[1], o = {}) {
  return async () => {
    const probs = liveRouteProblems(env, argv1, o);
    return probs.length ? { status: 'error', reasons: probs, kind: 'configuration' } : { status: 'ok', kind: 'configuration (not proof of authentication)' };
  };
}

/** The reviewed arm-A profile (pilot-config.json, frozen 10583) with the arm-A research route. */
function armAProfile() {
  const P = require('../sandbox/agent-profile');
  return { ...P.profileFromConfig(P.loadReviewed()), auth_route: ROUTE };
}

/**
 * One arm-A trial through the REAL runner pieces (KAN-112 amendment 1 + KAN-113 profile):
 * pilotTrial/pilotClassify/pilotRecord (bench/experiment-run.js), runAgentSandboxed (preflight, per-attempt sign-in,
 * one attempt, classifyAttempt billing/model evidence), the 1,800 s coding allowance and the 90-min total, then the
 * capture record (lib/research/candidate.js). `seam` replaces runSandboxed (tests and the labelled dry run only).
 * Returns the pilot record, the candidate record, the EXACT captured bytes and the parsed agent report (never the raw stream).
 */
async function runTrial(o) {
  const { pilotTrial, pilotRecord } = require('../../bench/experiment-run');
  const { runAgentSandboxed } = require('../../agent/runner');
  const { agentFailure } = require('../../bench/arms');
  const { candidateRecord } = require('../research/candidate');
  const P = require('../sandbox/agent-profile');
  const budget = require('../budget');
  const TP = require('./trial-policy');
  const a = o.amendment;
  const codingMs = o.codingMsOverride || a.time.coding_s * 1000;
  const profile = o.profile || armAProfile();
  if (!o.codingMsOverride) {
    const bad = P.budgetProblem(profile, { agentTimeMs: codingMs, qb28Arm: 'A', armMaxAttempts: 1 });
    if (bad) throw new Error(`arm-A: ${bad}`);
  }
  const pilot = { amendment: a, sha256: o.amendmentSha256, scale: 1, totalMs: a.time.trial_total_s * 1000, codingMs };
  const pt = pilotTrial(pilot, { signInAdapter: o.signInAdapter });
  const br = budget.startRun({ deadlineMs: pt.totalMs, agent: 'claude-code' });
  br.signal.addEventListener('abort', () => { if (!pt.abortStage) pt.abortStage = pt.stage; });
  const t0 = Date.now(); let r = null; let out;
  pt.stage = 'arm';
  try {
    r = await runAgentSandboxed(o.briefing, o.repoPath, { timeoutMs: codingMs, agentProfile: profile, pilot: pt.hooks, signal: br.signal, checks: [],
      ...(o.briefingGuard ? { briefingGuard: o.briefingGuard } : {}),
      // KAN-112 (10660): the paired driver uses its own route guard (lib/pilot/pair.js); batch 1 keeps the arm-A guard
      ...(o.seam ? { runSandboxed: o.seam, approvedAuthRoutes: [ROUTE] } : o.route === 'paired' ? { pairedResearchRoute: true } : { armAResearchRoute: true }) });
    const failed = agentFailure(r);
    out = r.status === 'blocked' ? { status: 'agent_error', detail: String(r.error || '').slice(0, 500), patch: '' }
      : failed ? { ...failed, patch: r.diff || '' } : { status: 'completed', patch: r.diff || '' };
  } catch (e) {
    out = { status: 'infra_error', detail: String(e && e.message).slice(0, 500), patch: '' };
  } finally { budget.endRun(); }
  const agentMs = r && r.sandbox && r.sandbox.stages && r.sandbox.stages.agent && Number.isFinite(r.sandbox.stages.agent.duration_ms) ? r.sandbox.stages.agent.duration_ms : 0;
  out.agent_ms = agentMs; out.attempts = 1;
  pt.clock.debitCoding(agentMs); pt.stage = 'grading';
  const slot = { trial_id: o.trialId, task_id: o.taskId, repetition: 1, arm: 'A' };
  const pilotRec = pilotRecord(pt, out, null, slot, pilot);
  const cand = candidateRecord(r || { status: out.status }, { label: o.label, env: { task_id: o.taskId }, qbCommit: o.qbCommit || null, graderTask: o.graderTask || null });
  const patch = r && r.patch_raw ? Buffer.from(r.patch_raw) : Buffer.alloc(0);
  return {
    pilot: pilotRec, candidate: cand, patch,
    grade_now: cand.gradable && pilotRec.patch_use === 'grade_under_10583' && patch.length > 0,
    // stop the batch on a usage limit or ANY authentication problem (a sign-in/configuration failure included); never on a wrong answer
    stop_batch: ['usage_limit', 'auth_timeout', 'policy_violation'].includes(pilotRec.primary) || (pilotRec.flags || []).some((f) => ['usage_limit', 'auth_timeout'].includes(f))
      || (pilotRec.reasons || []).some((x) => /sign-in|arm-A route|auth/i.test(String(x))),
    agent_report: (r && r.agent_report) || null, attempt_outcome: (r && r.pilot_outcome) || null, attempt_reasons: ((r && r.pilot_reasons) || []).slice(0, 20),
    sandbox: r && r.sandbox ? { status: r.status, credential_mode: r.sandbox.credential_mode ?? null, deps: r.sandbox.deps, stages: r.sandbox.stages, capture: r.sandbox.capture && r.sandbox.capture.verdict } : null,
    wall_ms: Date.now() - t0, profile: { ...profile }, coding_ms: codingMs, total_ms: pt.totalMs, precedence: TP.PRECEDENCE,
  };
}

// ── In-job output scan (runs where the exact token value is available; never prints it) ──
const SECRET_PATTERNS = /(sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_|ghs_|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY)/;
/** Lines ADDED by the official test patch that are not plain structure: hidden-answer material. */
function hiddenLines(testPatch, min = 20) {
  return String(testPatch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= min && /[A-Za-z]/.test(l));
}
/**
 * kind 'secret_only'  (the candidate patch): refused only for a secret; hidden-answer overlap is COUNTED, not refused
 * kind 'public'       (records/summaries): refused for a secret, a required test name, a hidden test-patch line or diff text
 */
function scanText(text, { secret = null, names = [], testPatch = '', kind = 'public' } = {}) {
  const t = String(text);
  const refused = []; let overlap = 0;
  if (secret && secret.length >= 8 && t.includes(secret)) refused.push('exact secret value');
  if (SECRET_PATTERNS.test(t)) refused.push('secret pattern');
  const norm = t.replace(/\s+/g, ' ');
  const hl = hiddenLines(testPatch);
  for (const l of hl) if (norm.includes(l)) overlap++;
  if (kind === 'public') {
    for (const n of names) if (n && t.includes(n)) { refused.push('required test name'); break; }
    if (overlap) refused.push('hidden test-patch line');
    if (/diff --git|^@@ /m.test(t)) refused.push('diff text');
  }
  return { refused: [...new Set(refused)], hidden_overlap_lines: overlap };
}

module.exports = { ROUTE, FORBIDDEN_ENV, armABriefing, liveRouteProblems, signInAdapter, readApprovals, armAProfile, runTrial, scanText, hiddenLines };
