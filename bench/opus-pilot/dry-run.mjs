#!/usr/bin/env node
// KAN-113 dry run: AUTH-FREE and NON-INFERENCE. It never starts `claude`, `qb`, docker or any network call.
//   node bench/opus-pilot/dry-run.mjs --config=<pilot-config.json> --out=<dir>
// It checks the config in dry-run mode, refuses if any credential or billing-override variable is present in the
// environment (names only, never values), checks that the configured Claude Code version (if set) matches QB's agent
// image pin, then writes plan.json (the exact argv/env each arm WOULD use, executed: false) and a sample audit record
// that must validate. A dry run can verify the REQUESTED model only; it cannot observe which model serves a request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPilotConfig } from './config.mjs';
import { validateTrialRecord, SCHEMA, USAGE_FIELDS } from './audit.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../lib/sandbox/agent-profile.js');
const AG = require('../../lib/sandbox/agent.js');
const { POLICIES } = require('../../lib/sandbox/egress.js');
const { ARMS } = require('../../bench/arms.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
// Variables that would supply credentials or switch billing/provider (Anthropic's Pro/Max article: an ANTHROPIC_API_KEY
// makes Claude Code use API billing instead of the subscription).
export const OVERRIDE_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function imagePin() {
  const df = fs.readFileSync(path.join(ROOT, 'sandbox', 'agent', 'Dockerfile'), 'utf8');
  return (df.match(/^ARG CLAUDE_VERSION=(\S+)$/m) || [])[1] || null;
}

// The exact `claude` command both containerized arms run (sandbox/agent/entry.sh: exec claude -p "$@"; briefing on stdin)
export function plannedArgv(cfg) { return ['claude', '-p', ...P.buildAgentArgs(P.profileFromConfig(cfg))]; }

// Refusal checks on fixtures (no Docker, no model): what stops a misconfigured run, and where
const fixtureStream = ({ apiKeySource = 'none', overage = false, model = 'claude-opus-5-5', version = '2.1.322' } = {}) => [
  { type: 'system', subtype: 'init', model, apiKeySource, claude_code_version: version },
  { type: 'assistant', message: { model } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: overage, overageStatus: overage ? 'allowed' : 'rejected' } },
  { type: 'result', subtype: 'success', is_error: false, usage: {}, modelUsage: { [model]: { canonicalModel: model, provider: 'firstParty' } } },
].map((x) => JSON.stringify(x)).join('\n') + '\n';
export async function refusalChecks(cfg) {
  const prof = P.profileFromConfig(cfg);
  const { runAgentSandboxed } = require('../../agent/runner.js');
  const live = await runAgentSandboxed('<no task>', '/nonexistent', { agentProfile: prof });           // production path, no seam
  const wrongVersion = P.checkProfile({ ...prof, claude_code_version: '2.1.288' }, { imagePin: AG.CLAUDE_VERSION, approved: [prof.auth_route] });
  const bypass = P.checkProfile({ ...prof, permission_mode: 'bypassPermissions' }, { imagePin: AG.CLAUDE_VERSION, approved: [prof.auth_route] });
  const billingKey = P.verifyStream(fixtureStream({ apiKeySource: 'ANTHROPIC_API_KEY' }), prof);
  const billingOverage = P.verifyStream(fixtureStream({ overage: true }), prof);
  const wrongModel = P.verifyStream(fixtureStream({ model: 'claude-sonnet-5-5' }), prof);
  const good = P.verifyStream(fixtureStream(), prof);
  const missingBilling = P.classifyAttempt({ stdout: fixtureStream().split('\n').filter((l) => !l.includes('rate_limit_event')).join('\n') }, prof);
  const truncated = P.classifyAttempt({ stdout: fixtureStream(), dropped: 1024 }, prof);
  const timeout = P.classifyAttempt({ stdout: fixtureStream().split('\n').filter((l) => !l.includes('"result"')).join('\n'), sandboxState: 'timeout' }, prof);
  const tampered = P.checkProfile({ ...prof, model: 'claude-sonnet-5-5' }, { imagePin: AG.CLAUDE_VERSION, approved: [prof.auth_route] });
  const deadlineEach = P.budgetProblem(prof, { agentTimeMs: 3 * prof.agent_time_ms, qb28Arm: 'E', armMaxAttempts: ARMS.E.max_attempts });   // "30 minutes each" misconfig
  const deadlineOk = P.budgetProblem(prof, { agentTimeMs: prof.agent_time_ms, qb28Arm: 'E', armMaxAttempts: ARMS.E.max_attempts });
  const nonPilotArm = P.budgetProblem(prof, { agentTimeMs: prof.agent_time_ms, qb28Arm: 'B', armMaxAttempts: ARMS.B.max_attempts });
  return {
    configured_pilot_run: { status: live.status, error: live.error, sandbox_started: live.sandbox !== null },
    version_mismatch: { refused: wrongVersion.length > 0, errors: wrongVersion },
    bypass_permissions: { refused: bypass.length > 0, errors: bypass },
    billing_api_key: { refused: !billingKey.ok, reasons: billingKey.reasons },
    billing_overage: { refused: !billingOverage.ok, reasons: billingOverage.reasons },
    wrong_served_model: { refused: !wrongModel.ok, reasons: wrongModel.reasons },
    deadline_misconfigured_90_min_total: { refused: deadlineEach !== null, reason: deadlineEach },
    deadline_frozen_30_min_shared: { accepted: deadlineOk === null },
    non_pilot_arm_B: { refused: nonPilotArm !== null, reason: nonPilotArm },
    missing_billing_telemetry: { outcome: missingBilling.outcome },
    truncated_output: { outcome: truncated.outcome },
    coding_timeout: { outcome: timeout.outcome, evidence_complete: timeout.evidence_complete },
    tampered_profile: { refused: tampered.length > 0, errors: tampered },
    correct_stream: { accepted: good.ok, outcome: good.outcome },
  };
}

async function main(argv) {
  const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? '' : a.slice(i + 1)]; }));
  if (!opt.config || !opt.out) { console.error('usage: dry-run.mjs --config=<file> --out=<dir>'); return 2; }
  const cfg = JSON.parse(fs.readFileSync(opt.config, 'utf8'));
  const cerr = checkPilotConfig(cfg, 'dry-run');
  if (cerr.length) { console.error(`dry run refused: config problems:\n  ${cerr.join('\n  ')}`); return 1; }

  const present = OVERRIDE_VARS.filter((v) => typeof process.env[v] === 'string' && process.env[v] !== '');
  if (present.length) { console.error(`dry run refused: credential/billing-override variables are set (values not shown): ${present.join(', ')}. Unset them; the pilot must not fall back to API billing or another provider.`); return 1; }

  const pin = imagePin();
  if (!pin) { console.error('dry run refused: could not read the Claude Code version pinned in sandbox/agent/Dockerfile'); return 1; }
  if (cfg.claude_code_version !== null && cfg.claude_code_version !== pin) {
    console.error(`dry run refused: configured Claude Code version ${cfg.claude_code_version} differs from QB's agent image pin ${pin}; both arms must run one version`); return 1;
  }
  const version = cfg.claude_code_version || pin;
  const argvA = plannedArgv(cfg);
  const plan = {
    schema: 'qb-opus-pilot-dry-run/1', executed_nothing: true, config_frozen: cfg.frozen, frozen_by: cfg.frozen_by,
    config_sha256: sha(fs.readFileSync(opt.config)),
    claude_code_version: { used_for_plan: version, source: cfg.claude_code_version ? 'config' : 'QB agent image pin (config unset)', image_pin: pin },
    requested_model: cfg.requested_model,
    served_model: 'unverified: a dry run cannot observe which model serves a request',
    auth_route: 'owner decision (KAN-113 10582): arm A = host claude on the owner sign-in (smoke-tested); arm B = QB Mode S (unverified). The dry run provides no credential to either arm',
    budgets: cfg.budgets, stop_rules: cfg.stop_rules,
    arms: [
      ...['A', 'B'].map((arm) => ({
        arm, route_status: (cfg.arm_routes && cfg.arm_routes[arm] && cfg.arm_routes[arm].status) || 'unknown',
        qb28_arm: arm === 'A' ? 'A' : 'E', max_attempts: ARMS[arm === 'A' ? 'A' : 'E'].max_attempts,
        briefing: arm === 'A' ? 'task prompt + native note (QB-28 arm A)' : 'approved contract briefing (QB-28 arm E, QB production orchestration)',
        launcher: 'QB agent container (same image for both arms)', image: { tag: AG.AGENT_IMAGE, id: opt['image-id'] || 'not inspected' },
        claude_code_version: version, argv: argvA,
        env: Object.fromEntries(AG.AGENT_ENV.map((e) => e.split(/=(.*)/s).slice(0, 2))),
        network: { docker: '--network none', egress_allowlist: [...POLICIES.INFERENCE] },
        managed_settings: JSON.parse(fs.readFileSync(path.join(ROOT, 'sandbox', 'agent', 'managed-settings.json'), 'utf8')),
        deadline: { agent_time_ms_shared_across_attempts: cfg.budgets.coding_wall_clock_s * 1000 },
        credentials: 'none provided (auth route unapproved; QB stored-credential flow not used for the pilot)', executed: false,
      })),
    ],
  };
  const prompt = '<dry-run placeholder prompt: no task material>';
  const unavailable = { unavailable: 'dry run: nothing executed' };
  const sample = {
    schema: SCHEMA, trial_id: 'trial_' + sha('dry-run').slice(0, 16), pair_id: 'pair_' + sha('pair').slice(0, 8), arm: 'A', order_in_pair: 1,
    task: { task_id: 'qbt_000000000000', dataset_revision: '0'.repeat(40), spec_sha256: '0'.repeat(64), contract_sha256: null, grader_sha256: '0'.repeat(64), base_commit: '0'.repeat(40) },
    versions: { qb_commit: '0'.repeat(40), claude_code: version, config_sha256: plan.config_sha256 },
    config: { requested_model: cfg.requested_model, effort: cfg.effort, tools: { allow: [], deny: ['WebFetch', 'WebSearch'] }, network: 'dry run: none' },
    environment: { os: process.platform, arch: process.arch, cpu_model: 'dry run', cpu_count: 1, ram_bytes: 1, container_digests: [] },
    prompts: [{ role: 'user', sha256: sha(prompt), text: prompt }],
    transcript: { path: 'none (dry run)', sha256: sha('') },
    timing: { started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:00Z', deadline_at: '2026-01-01T00:00:00Z' },
    attempts: [], test_output: { unavailable: 'dry run: nothing executed' },
    qb_verdict: null, independent_score: 'INVALID_MEASUREMENT', interruption: { reason: 'none', detail_sha256: null },
    model: { requested: cfg.requested_model, served: { unobservable: 'dry run: no request was made' } },
    usage: Object.fromEntries(USAGE_FIELDS.map((f) => [f, unavailable])), auxiliary_usage: [], human_events: [],
    billing_route: { api_key_source: unavailable, provider: unavailable, is_using_overage: unavailable, overage_status: unavailable },
  };
  const verrs = validateTrialRecord(sample);
  if (verrs.length) { console.error(`dry run failed: the sample record does not validate:\n  ${verrs.join('\n  ')}`); return 1; }
  plan.refusal_checks = await refusalChecks(cfg);
  fs.mkdirSync(opt.out, { recursive: true });
  fs.writeFileSync(path.join(opt.out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  fs.writeFileSync(path.join(opt.out, 'sample-record.json'), JSON.stringify(sample, null, 2) + '\n');
  console.log(`dry run ok (nothing executed): plan.json and sample-record.json in ${opt.out}; config ${cfg.frozen ? 'frozen' : 'UNFROZEN'}; Claude Code ${version}; served model unverified`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
