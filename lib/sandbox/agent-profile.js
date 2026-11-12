/**
 * lib/sandbox/agent-profile.js — the Opus 5.5 pilot's agent profile (KAN-112 freeze 10583, fairness decision; KAN-113).
 *
 * Both pilot arms run plain, unmodified Claude Code in the SAME pinned QB container with the SAME args:
 *   explicit model, structured output (stream-json), explicit restricted permissions (dontAsk + an allowlist,
 *   web tools denied), no session persistence, no MCP servers. QB's legacy `--dangerously-skip-permissions`
 *   is never used for the pilot.
 *
 * Auth: no auth route is approved for the pilot yet (APPROVED_AUTH_ROUTES is empty). QB's Mode S flow (stored
 * credential, copied per run, refreshed with a model call) is never used for the pilot, so a pilot run is refused
 * before any sandbox, credential copy or pre-run refresh call. A route is added here only after the reviewer
 * approves one that keeps QB from storing or forwarding subscription credentials.
 */
const { fromStreamJson } = require('./stream-json');

const APPROVED_AUTH_ROUTES = Object.freeze([]);
const PILOT_PERMISSION_MODE = 'dontAsk';
const PILOT_ALLOWED_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite']);
const PILOT_DISALLOWED_TOOLS = Object.freeze(['WebFetch', 'WebSearch']);
const AGENT_STDOUT_MAX_BYTES = 16 * 1024 * 1024;   // a 30-minute stream-json session; the head (init) and tail (result) are needed

/** The profile from the frozen pilot config (bench/opus-pilot/pilot-config.json). */
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

/** KAN-112 freeze: a pilot arm runs only with exactly the frozen shared budget and attempt limit. */
function budgetProblem(p, { agentTimeMs, armMaxAttempts }) {
  if (agentTimeMs !== p.agent_time_ms) return `pilot budget: agent time ${agentTimeMs} ms differs from the frozen ${p.agent_time_ms} ms (one budget shared by all attempts)`;
  if (armMaxAttempts > 1 && armMaxAttempts !== p.max_attempts) return `pilot budget: attempt limit ${armMaxAttempts} differs from the frozen ${p.max_attempts}`;
  return null;
}

/** Preflight: problems that stop a pilot run before anything starts ([] = may start). */
function checkProfile(p, { imagePin, approved = APPROVED_AUTH_ROUTES } = {}) {
  const errs = [];
  if (!p || typeof p.model !== 'string' || !p.model) errs.push('pilot profile: an explicit model is required');
  if (!p || p.claude_code_version !== imagePin) errs.push(`pilot profile: Claude Code version ${p && p.claude_code_version} differs from the agent image pin ${imagePin}`);
  if (!p || p.permission_mode !== PILOT_PERMISSION_MODE) errs.push(`pilot profile: permission mode must be ${PILOT_PERMISSION_MODE} (explicit, restricted; never bypassPermissions)`);
  if (!p || JSON.stringify(p.allowed_tools) !== JSON.stringify(PILOT_ALLOWED_TOOLS)) errs.push('pilot profile: allowed tools must be the frozen allowlist');
  if (!p || JSON.stringify(p.disallowed_tools) !== JSON.stringify(PILOT_DISALLOWED_TOOLS)) errs.push('pilot profile: disallowed tools must be the frozen denylist');
  if (!p || !approved.includes(p.auth_route)) errs.push(`pilot profile: auth route "${p && p.auth_route}" is not approved for the pilot (QB's stored-credential flow is never used)`);
  return errs;
}

/** The exact args after `claude -p` for both pilot arms. */
function buildAgentArgs(p) {
  return ['--model', p.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config',
    '--permission-mode', PILOT_PERMISSION_MODE, '--allowed-tools', PILOT_ALLOWED_TOOLS.join(','), '--disallowed-tools', PILOT_DISALLOWED_TOOLS.join(',')];
}

/** Verify Claude Code's own report: the served model is the requested one; subscription only; no overage. Fails closed. */
function verifyStream(stdout, p) {
  const report = fromStreamJson(stdout);
  const reasons = [];
  if (report.model.served !== p.model) reasons.push(`served model ${typeof report.model.served === 'string' ? report.model.served : `unobservable (${report.model.served.unobservable})`}, requested ${p.model}`);
  if (report.billing_route.api_key_source !== 'none') reasons.push(`billing route: API key source is ${JSON.stringify(report.billing_route.api_key_source)}, expected "none" (subscription)`);
  if (report.billing_route.is_using_overage === true) reasons.push('billing route: overage (paid usage) was in use');
  return { ok: reasons.length === 0, reasons, report };
}

module.exports = { budgetProblem, APPROVED_AUTH_ROUTES, PILOT_PERMISSION_MODE, PILOT_ALLOWED_TOOLS, PILOT_DISALLOWED_TOOLS, AGENT_STDOUT_MAX_BYTES,
  profileFromConfig, checkProfile, buildAgentArgs, verifyStream };
