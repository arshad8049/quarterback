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

export function plannedArgv(cfg) {
  return ['claude', '-p', '<prompt from file; recorded in the audit record>', '--model', cfg.requested_model,
    ...(cfg.effort ? ['--effort', cfg.effort] : []), '--output-format', 'stream-json', '--verbose'];
}

function main(argv) {
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
    schema: 'qb-opus-pilot-dry-run/1', executed_nothing: true, config_frozen: cfg.frozen,
    config_sha256: sha(fs.readFileSync(opt.config)),
    claude_code_version: { used_for_plan: version, source: cfg.claude_code_version ? 'config' : 'QB agent image pin (config unset)', image_pin: pin },
    requested_model: cfg.requested_model,
    served_model: 'unverified: a dry run cannot observe which model serves a request',
    auth_route: 'BLOCKED pending Anthropic clarification on option A (KAN-113 10579); no credential is provided to either arm in this plan',
    budgets: cfg.budgets, stop_rules: cfg.stop_rules,
    arms: [
      { arm: 'A', launcher: 'unmodified Claude Code CLI', claude_code_version: version, argv: argvA, env: { DISABLE_AUTOUPDATER: '1' }, executed: false },
      { arm: 'B', launcher: 'QB agent stage (unmodified Claude Code CLI in the QB container)', claude_code_version: version, argv: argvA,
        env: { HOME: '/tmp/home', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }, executed: false },
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
  };
  const verrs = validateTrialRecord(sample);
  if (verrs.length) { console.error(`dry run failed: the sample record does not validate:\n  ${verrs.join('\n  ')}`); return 1; }
  fs.mkdirSync(opt.out, { recursive: true });
  fs.writeFileSync(path.join(opt.out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  fs.writeFileSync(path.join(opt.out, 'sample-record.json'), JSON.stringify(sample, null, 2) + '\n');
  console.log(`dry run ok (nothing executed): plan.json and sample-record.json in ${opt.out}; config ${cfg.frozen ? 'frozen' : 'UNFROZEN'}; Claude Code ${version}; served model unverified`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
