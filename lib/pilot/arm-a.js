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

module.exports = { ROUTE, FORBIDDEN_ENV, armABriefing, liveRouteProblems, signInAdapter, readApprovals };
