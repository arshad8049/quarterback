// KAN-113: the per-trial audit record of the Opus 5.5 pilot (KAN-109), and its validator.
// validateTrialRecord(record, { forbidden }) returns a list of problems ([] = valid). Rules from the KAN-113 card:
//   * never invent missing data: every token-usage field is an integer count or { unavailable: "<reason>" };
//     the served model is a real id or { unobservable: "<reason>" };
//   * no credentials anywhere (anything credential-like is refused, and the error never echoes it);
//   * hidden evaluator data stays out of prompts (`forbidden`, reported by index only);
//   * API-equivalent costs only as values labelled 'estimate' (never presented as actual subscription charges);
//   * arm A (Claude Code alone) has no contract and no QB verdict; arm B (through QB) has both.
import crypto from 'node:crypto';

export const SCHEMA = 'qb-opus-pilot-trial/1';
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const SCORES = ['PASS', 'INCORRECT', 'NO_USABLE_PATCH', 'INFRA_INTERRUPTION', 'QB_BLOCK', 'INVALID_MEASUREMENT'];
export const INTERRUPTIONS = ['none', 'auth', 'rate_limit', 'timeout', 'host'];
export const QB_VERDICTS = ['approved', 'rejected', 'abstained', 'blocked'];
export const HUMAN_EVENTS = ['contract_authoring', 'contract_approval', 'setup', 'sign_in', 'clarification', 'correction', 'review'];
export const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];
const TOP = ['schema', 'trial_id', 'pair_id', 'arm', 'order_in_pair', 'task', 'versions', 'config', 'environment', 'prompts', 'transcript', 'timing',
  'attempts', 'test_output', 'qb_verdict', 'independent_score', 'interruption', 'model', 'usage', 'auxiliary_usage', 'human_events', 'estimates', 'billing_route'];
// Credential-like content. Matched against the whole serialized record; errors name the pattern, never the match.
const SECRETS = [
  ['an Anthropic key/token prefix', /sk-ant-/], ['a Bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{10,}/], ['an OAuth credential blob', /claudeAiOauth/],
  ['an access/refresh token field', /(access|refresh)[_-]?token["']?\s*[:=]/i], ['a credential environment assignment', /(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\s*=\s*\S/],
];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

function usageErrors(u, where, errs) {
  if (!isObj(u)) { errs.push(`${where}: missing usage object`); return; }
  for (const f of USAGE_FIELDS) {
    const v = u[f];
    if (v === undefined || v === null) errs.push(`${where}.${f}: missing; never invent a value, mark it unavailable with a reason`);
    else if (Number.isInteger(v)) { if (v < 0) errs.push(`${where}.${f}: negative count`); }
    else if (isObj(v) && 'unavailable' in v) { if (!nonEmpty(v.unavailable)) errs.push(`${where}.${f}: an unavailable marker needs a reason`); }
    else errs.push(`${where}.${f}: must be an integer count or { unavailable: "<reason>" }`);
  }
  for (const k of Object.keys(u)) if (!USAGE_FIELDS.includes(k)) errs.push(`${where}: unknown usage field ${k}`);
}

export function validateTrialRecord(r, { forbidden = [] } = {}) {
  const errs = [];
  if (!isObj(r)) return ['record is not an object'];
  for (const k of Object.keys(r)) if (!TOP.includes(k)) errs.push(`unknown field ${k}`);
  for (const k of TOP) if (k !== 'estimates' && !(k in r)) errs.push(`missing field ${k}`);
  if (r.schema !== SCHEMA) errs.push(`schema must be ${SCHEMA}`);
  if (!/^trial_[0-9a-f]{16}$/.test(r.trial_id || '')) errs.push('trial_id must be an opaque trial_<16 hex>');
  if (!/^pair_[0-9a-f]{8}$/.test(r.pair_id || '')) errs.push('pair_id must be pair_<8 hex>');
  if (!['A', 'B'].includes(r.arm)) errs.push('arm must be A (Claude Code alone) or B (through QB)');
  if (![1, 2].includes(r.order_in_pair)) errs.push('order_in_pair must be 1 or 2');

  const t = r.task || {};
  if (!/^qbt_[0-9a-f]{12}$/.test(t.task_id || '')) errs.push('task.task_id must be qbt_<12 hex>');
  if (!HEX40.test(t.dataset_revision || '')) errs.push('task.dataset_revision must be 40 hex');
  if (!HEX40.test(t.base_commit || '')) errs.push('task.base_commit must be 40 hex');
  for (const k of ['spec_sha256', 'grader_sha256']) if (!HEX64.test(t[k] || '')) errs.push(`task.${k} must be 64 hex`);
  if (r.arm === 'A' && t.contract_sha256 !== null) errs.push('arm A has no QB contract: task.contract_sha256 must be null');
  if (r.arm === 'B' && !HEX64.test(t.contract_sha256 || '')) errs.push('arm B needs the approved contract: task.contract_sha256 must be 64 hex');

  const v = r.versions || {};
  if (!HEX40.test(v.qb_commit || '')) errs.push('versions.qb_commit must be 40 hex');
  if (!/^\d+\.\d+\.\d+$/.test(v.claude_code || '')) errs.push('versions.claude_code must be an exact version');
  if (!HEX64.test(v.config_sha256 || '')) errs.push('versions.config_sha256 must be 64 hex');

  const c = r.config || {};
  if (!nonEmpty(c.requested_model)) errs.push('config.requested_model is required (pass --model explicitly)');
  if (!isObj(c.tools) || !Array.isArray(c.tools.allow) || !Array.isArray(c.tools.deny)) errs.push('config.tools must list allow and deny');
  if (!nonEmpty(c.network)) errs.push('config.network is required');

  const e = r.environment || {};
  for (const k of ['os', 'arch', 'cpu_model']) if (!nonEmpty(e[k])) errs.push(`environment.${k} is required`);
  for (const k of ['cpu_count', 'ram_bytes']) if (!Number.isInteger(e[k]) || e[k] <= 0) errs.push(`environment.${k} must be a positive integer`);
  if (!Array.isArray(e.container_digests) || !e.container_digests.every((d) => /^sha256:[0-9a-f]{64}$/.test(d))) errs.push('environment.container_digests must be sha256:<64 hex> digests');

  if (!Array.isArray(r.prompts) || !r.prompts.length) errs.push('prompts: at least one exact prompt is required');
  else r.prompts.forEach((p, i) => {
    if (!['system', 'user', 'contract', 'clarification'].includes(p.role)) errs.push(`prompts[${i}].role is not a known role`);
    if (typeof p.text !== 'string' || sha(p.text) !== p.sha256) errs.push(`prompts[${i}]: text does not match its sha256`);
    forbidden.forEach((f, j) => { if (typeof p.text === 'string' && f && p.text.includes(f)) errs.push(`prompts[${i}] contains hidden evaluator item #${j}`); });
  });
  for (const k of ['transcript']) if (!isObj(r[k]) || !nonEmpty(r[k].path) || !HEX64.test(r[k].sha256 || '')) errs.push(`${k} needs a path and a 64-hex sha256`);
  const to = r.test_output;
  if (!(isObj(to) && ((nonEmpty(to.path) && HEX64.test(to.sha256 || '')) || nonEmpty(to.unavailable)))) errs.push('test_output needs a path + sha256, or { unavailable: "<reason>" }');

  const tm = r.timing || {};
  for (const k of ['started_at', 'ended_at', 'deadline_at']) if (!ISO.test(tm[k] || '')) errs.push(`timing.${k} must be an ISO UTC timestamp`);
  if (ISO.test(tm.started_at || '') && ISO.test(tm.ended_at || '') && Date.parse(tm.ended_at) < Date.parse(tm.started_at)) errs.push('timing.ended_at is before started_at');

  if (!Array.isArray(r.attempts)) errs.push('attempts must be a list');
  else r.attempts.forEach((a, i) => {
    if (!Number.isInteger(a.n) || a.n < 1) errs.push(`attempts[${i}].n must be a positive integer`);
    if (a.patch_sha256 !== null && !HEX64.test(a.patch_sha256 || '')) errs.push(`attempts[${i}].patch_sha256 must be 64 hex or null`);
    if (!Number.isInteger(a.patch_bytes) || a.patch_bytes < 0) errs.push(`attempts[${i}].patch_bytes must be a non-negative integer`);
  });

  if (r.arm === 'A' && r.qb_verdict !== null) errs.push('arm A has no QB: qb_verdict must be null');
  if (r.arm === 'B' && !QB_VERDICTS.includes(r.qb_verdict)) errs.push(`arm B qb_verdict must be one of ${QB_VERDICTS.join(', ')}`);
  if (!SCORES.includes(r.independent_score)) errs.push(`independent_score must be one of ${SCORES.join(', ')}`);
  const it = r.interruption || {};
  if (!INTERRUPTIONS.includes(it.reason)) errs.push(`interruption.reason must be one of ${INTERRUPTIONS.join(', ')}`);
  if (it.detail_sha256 !== null && !HEX64.test(it.detail_sha256 || '')) errs.push('interruption.detail_sha256 must be 64 hex or null');

  const m = r.model || {};
  if (!nonEmpty(m.requested)) errs.push('model.requested is required');
  if (!(nonEmpty(m.served) || (isObj(m.served) && nonEmpty(m.served.unobservable)))) errs.push('model.served must be the served model id, or { unobservable: "<reason>" }');

  // Billing route (owner decision 10582: subscription only, no paid fallback). From Claude Code's own output:
  // apiKeySource must be "none" and overage must not be in use; fields Claude Code did not report are marked unavailable.
  const b = r.billing_route;
  const na = (v) => isObj(v) && nonEmpty(v.unavailable);
  if (!isObj(b)) errs.push('billing_route is required');
  else {
    for (const k of Object.keys(b)) if (!['api_key_source', 'provider', 'is_using_overage', 'overage_status'].includes(k)) errs.push(`billing_route: unknown field ${k}`);
    if (!(b.api_key_source === 'none' || na(b.api_key_source))) errs.push('billing_route.api_key_source must be "none" (subscription, no API key)');
    if (!(nonEmpty(b.provider) || na(b.provider))) errs.push('billing_route.provider must be a provider name or unavailable');
    if (b.is_using_overage === true) errs.push('billing_route: overage (paid usage) was in use; the pilot allows no paid fallback');
    else if (!(b.is_using_overage === false || na(b.is_using_overage))) errs.push('billing_route.is_using_overage must be false or unavailable');
    if (!(nonEmpty(b.overage_status) || na(b.overage_status))) errs.push('billing_route.overage_status must be a status or unavailable');
  }
  usageErrors(r.usage, 'usage', errs);
  if (!Array.isArray(r.auxiliary_usage)) errs.push('auxiliary_usage must be a list (empty if none)');
  else r.auxiliary_usage.forEach((a, i) => {
    if (!nonEmpty(a.purpose) || !nonEmpty(a.model)) errs.push(`auxiliary_usage[${i}] needs purpose and model`);
    usageErrors(a.usage, `auxiliary_usage[${i}].usage`, errs);
  });
  if (!Array.isArray(r.human_events)) errs.push('human_events must be a list');
  else r.human_events.forEach((h, i) => {
    if (!HUMAN_EVENTS.includes(h.kind)) errs.push(`human_events[${i}].kind must be one of ${HUMAN_EVENTS.join(', ')}`);
    if (!ISO.test(h.at || '')) errs.push(`human_events[${i}].at must be an ISO UTC timestamp`);
    if (typeof h.minutes !== 'number' || !(h.minutes >= 0)) errs.push(`human_events[${i}].minutes must be a non-negative number`);
  });
  if (r.estimates !== undefined) {
    if (!isObj(r.estimates)) errs.push('estimates must be an object');
    else for (const [k, x] of Object.entries(r.estimates)) {
      if (!isObj(x) || x.label !== 'estimate' || typeof x.value !== 'number' || !nonEmpty(x.basis)) errs.push(`estimates.${k} must be { value, label: "estimate", basis } (never an actual charge)`);
    }
  }

  const text = JSON.stringify(r);
  for (const [what, re] of SECRETS) if (re.test(text)) errs.push(`credential-like content found (${what}); records must never contain credentials`);
  return errs;
}
