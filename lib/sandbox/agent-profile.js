/**
 * lib/sandbox/agent-profile.js — the Opus 5.5 pilot's agent profile (KAN-112 freeze 10583, fairness 10586; KAN-113 10589).
 *
 * Both pilot arms run plain, unmodified Claude Code in the SAME pinned QB container with the SAME args:
 *   explicit model, structured output (stream-json), explicit restricted permissions (dontAsk + an allowlist,
 *   web tools denied), no session persistence, no MCP servers. QB's legacy `--dangerously-skip-permissions`
 *   is never used for the pilot.
 *
 * Everything is checked against the REVIEWED config (bench/opus-pilot/pilot-config.json, frozen), never against
 * whatever profile a caller passes: a tampered or malformed profile is refused, and the budget and attempt limits
 * come from the reviewed file (pilot arm A = QB-28 A, 1 attempt; pilot arm B = QB-28 E, up to 3; 1,800 s shared).
 *
 * Auth: no auth route is approved (APPROVED_AUTH_ROUTES is empty), so every pilot run is refused before any sandbox,
 * credential copy or pre-run refresh call. QB's Mode S flow is never used for the pilot.
 *
 * Evidence (classifyAttempt): one of verified | incomplete_evidence | usage_limit | coding_timeout | policy_violation.
 * Missing billing telemetry is UNKNOWN, never proof of free usage; telemetry after a request is evidence, not a cap.
 */
const fs = require('fs');
const path = require('path');
const { fromStreamJson } = require('./stream-json');

const REVIEWED_CONFIG = path.join(__dirname, '..', '..', 'bench', 'opus-pilot', 'pilot-config.json');
const APPROVED_AUTH_ROUTES = Object.freeze([]);
const PILOT_PERMISSION_MODE = 'dontAsk';
const PILOT_ALLOWED_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite']);
const PILOT_DISALLOWED_TOOLS = Object.freeze(['WebFetch', 'WebSearch']);
const AGENT_STDOUT_MAX_BYTES = 16 * 1024 * 1024;   // a 30-minute stream-json session; init (head) and result (tail) are both required
const PROFILE_KEYS = ['model', 'claude_code_version', 'permission_mode', 'allowed_tools', 'disallowed_tools', 'auth_route', 'agent_time_ms', 'max_attempts'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function loadReviewed(file = REVIEWED_CONFIG) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** The profile from a pilot config (normally the reviewed one). */
function profileFromConfig(cfg) {
  const a = cfg.agent || {};
  return {
    model: cfg.requested_model, claude_code_version: cfg.claude_code_version,
    permission_mode: a.permission_mode, allowed_tools: a.allowed_tools, disallowed_tools: a.disallowed_tools,
    auth_route: a.auth_route,
    agent_time_ms: cfg.budgets && Number.isInteger(cfg.budgets.coding_wall_clock_s) ? cfg.budgets.coding_wall_clock_s * 1000 : null,
    max_attempts: cfg.budgets ? cfg.budgets.max_qb_attempts : null,
  };
}

/** Preflight: problems that stop a pilot run before anything starts ([] = may start). */
function checkProfile(p, { imagePin, approved = APPROVED_AUTH_ROUTES, reviewed = loadReviewed() } = {}) {
  if (!isObj(p)) return ['pilot profile: malformed (not an object)'];
  const errs = [];
  if (reviewed.frozen !== true || !Number.isInteger(reviewed.frozen_by)) errs.push('pilot profile: the reviewed config is not frozen');
  const expected = profileFromConfig(reviewed);
  for (const k of PROFILE_KEYS) {
    if (k === 'auth_route') continue;                       // approval is checked against the approved list below
    if (!same(p[k], expected[k])) errs.push(`pilot profile: ${k} differs from the reviewed config`);
  }
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.includes(k) && k !== 'arm') errs.push(`pilot profile: unknown field ${k}`);
  if (typeof p.model !== 'string' || !p.model) errs.push('pilot profile: an explicit model is required');
  if (p.claude_code_version !== imagePin) errs.push(`pilot profile: Claude Code version ${p.claude_code_version} differs from the agent image pin ${imagePin}`);
  if (p.permission_mode !== PILOT_PERMISSION_MODE) errs.push(`pilot profile: permission_mode must be ${PILOT_PERMISSION_MODE} (explicit, restricted; never bypassPermissions)`);
  if (!approved.includes(p.auth_route)) errs.push(`pilot profile: auth route "${p.auth_route}" is not approved for the pilot (QB's stored-credential flow is never used)`);
  return errs;
}

/** KAN-112 freeze: a pilot arm runs only as a reviewed pilot arm, with the reviewed shared budget and attempt limit. */
function budgetProblem(p, { agentTimeMs, qb28Arm, armMaxAttempts, reviewed = loadReviewed() } = {}) {
  const want = profileFromConfig(reviewed);
  const arms = Object.values(reviewed.pilot_arms || {});
  const entry = arms.find((a) => a.qb28_arm === qb28Arm);
  if (!entry) return `pilot budget: QB-28 arm ${qb28Arm} is not a pilot arm (reviewed: ${arms.map((a) => a.qb28_arm).join(', ')})`;
  if (!isObj(p) || p.agent_time_ms !== want.agent_time_ms) return `pilot budget: profile agent_time_ms ${isObj(p) ? p.agent_time_ms : '?'} differs from the reviewed ${want.agent_time_ms}`;
  if (agentTimeMs !== want.agent_time_ms) return `pilot budget: agent time ${agentTimeMs} ms differs from the reviewed ${want.agent_time_ms} ms (one budget shared by all attempts)`;
  if (p.max_attempts !== want.max_attempts) return `pilot budget: profile max_attempts (attempt limit) ${p.max_attempts} differs from the reviewed ${want.max_attempts}`;
  if (armMaxAttempts !== undefined && armMaxAttempts !== entry.max_attempts) return `pilot budget: QB-28 arm ${qb28Arm} attempt limit ${armMaxAttempts} differs from the reviewed ${entry.max_attempts}`;
  return null;
}

/** The exact args after `claude -p` for both pilot arms. */
function buildAgentArgs(p) {
  return ['--model', p.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config',
    '--permission-mode', PILOT_PERMISSION_MODE, '--allowed-tools', PILOT_ALLOWED_TOOLS.join(','), '--disallowed-tools', PILOT_DISALLOWED_TOOLS.join(',')];
}

/**
 * Classify one attempt from Claude Code's own stream-json, the stdout drop count and the agent stage state.
 * Order: policy_violation > usage_limit > coding_timeout > incomplete_evidence > verified.
 */
function classifyAttempt({ stdout, dropped = 0, sandboxState = 'completed' }, p) {
  const lines = String(stdout || '').split('\n').filter((l) => l.trim());
  const events = []; let malformed = 0;
  for (const l of lines) { try { events.push(JSON.parse(l)); } catch { malformed++; } }
  const incomplete = []; const violation = []; const limit = [];
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const assistants = events.filter((e) => e.type === 'assistant' && e.message && e.message.model);
  const result = [...events].reverse().find((e) => e.type === 'result');
  const rates = events.filter((e) => e.type === 'rate_limit_event' && e.rate_limit_info).map((e) => e.rate_limit_info);
  const mu = result && isObj(result.modelUsage) ? result.modelUsage : {};

  if (dropped > 0) incomplete.push(`output truncated (${dropped} bytes dropped)`);
  if (malformed) incomplete.push(`${malformed} malformed stream line(s)`);
  if (!init) incomplete.push('no init event');
  else {
    if (init.claude_code_version !== p.claude_code_version) incomplete.push(`unexpected Claude Code version ${init.claude_code_version} (expected ${p.claude_code_version})`);
    if (init.model !== p.model) violation.push(`served model ${init.model} (init) differs from requested ${p.model}`);
    if (init.apiKeySource !== 'none') violation.push(`billing route: API key source is ${JSON.stringify(init.apiKeySource)}, expected "none" (subscription)`);
  }
  if (!assistants.length) incomplete.push('no assistant response: the served model is not confirmed');
  for (const m of new Set(assistants.map((e) => e.message.model))) if (m !== p.model) violation.push(`served model ${m} (assistant message) differs from requested ${p.model}`);
  if (!result) incomplete.push('no result event');
  else {
    const providers = Object.values(mu).map((v) => v && v.provider);
    if (!providers.length || providers.some((x) => !x)) incomplete.push('provider missing in modelUsage');
    for (const x of new Set(providers.filter(Boolean))) if (x !== 'firstParty') violation.push(`provider ${x} is not first-party`);
    for (const k of Object.keys(mu)) if (k !== p.model) violation.push(`unexpected model ${k} in modelUsage`);
    if (result.api_error_status === 429) limit.push('API returned 429 (usage limit)');
  }
  if (!rates.length) incomplete.push('billing telemetry missing: billing route unknown (not free)');
  if (rates.some((r) => r.isUsingOverage === true)) violation.push('billing route: overage (paid usage) was in use in at least one event');
  if (rates.length && rates.some((r) => typeof r.isUsingOverage !== 'boolean')) incomplete.push('billing telemetry incomplete: overage state unknown in at least one event');
  for (const r of rates) if (r.status && r.status !== 'allowed') limit.push(`rate-limit window ${r.rateLimitType || '?'} status ${r.status}`);

  const outcome = violation.length ? 'policy_violation' : limit.length ? 'usage_limit' : sandboxState === 'timeout' ? 'coding_timeout'
    : incomplete.length ? 'incomplete_evidence' : 'verified';
  return { outcome, reasons: [...violation, ...limit, ...incomplete], evidence_complete: incomplete.length === 0, report: fromStreamJson(stdout) };
}

/** Back-compatible boolean view (verified only). */
function verifyStream(stdout, p, extra = {}) {
  const c = classifyAttempt({ stdout, ...extra }, p);
  return { ok: c.outcome === 'verified', reasons: c.reasons, report: c.report, outcome: c.outcome };
}

module.exports = { APPROVED_AUTH_ROUTES, PILOT_PERMISSION_MODE, PILOT_ALLOWED_TOOLS, PILOT_DISALLOWED_TOOLS, AGENT_STDOUT_MAX_BYTES, REVIEWED_CONFIG,
  loadReviewed, profileFromConfig, checkProfile, budgetProblem, buildAgentArgs, classifyAttempt, verifyStream };
