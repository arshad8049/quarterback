// KAN-113: the pilot configuration. Budgets and stopping rules stay CONFIGURABLE and unset until KAN-112 freezes
// the protocol. checkPilotConfig(config, mode) returns problems ([] = usable in that mode):
//   'dry-run' : unfrozen values are fine (nothing runs);
//   'live'    : the config must be frozen by a recorded KAN-112 decision, with every budget and the version set.
export const CONFIG_SCHEMA = 'qb-opus-pilot-config/1';
const CREDENTIAL_KEY = /(api[_-]?key|token|secret|password|credential|oauth|auth[_-]?header)/i;

function credentialKeys(o, at = '') {
  const out = [];
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (CREDENTIAL_KEY.test(k)) out.push(`${at}${k}`);
    out.push(...credentialKeys(v, `${at}${k}.`));
  }
  return out;
}

export function checkPilotConfig(c, mode) {
  const errs = [];
  if (!['dry-run', 'live'].includes(mode)) return [`unknown mode ${mode}`];
  if (!c || c.schema !== CONFIG_SCHEMA) errs.push(`schema must be ${CONFIG_SCHEMA}`);
  for (const k of credentialKeys(c)) errs.push(`credential-like key ${k} is not allowed in the pilot config`);
  if (typeof c.requested_model !== 'string' || !c.requested_model) errs.push('requested_model is required');
  if (typeof c.frozen !== 'boolean') errs.push('frozen must be true or false');
  if (mode === 'live') {
    if (c.frozen !== true) errs.push('config is not frozen: KAN-112 must freeze it before any live trial');
    if (!Number.isInteger(c.frozen_by)) errs.push('frozen_by must be the KAN-112 approval comment id');
    if (typeof c.claude_code_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.claude_code_version)) errs.push('claude_code_version must be set to the one version both arms use');
    for (const [k, v] of Object.entries(c.budgets || {})) if (k !== 'notes' && (v === null || v === undefined)) errs.push(`budgets.${k} is unset`);
    for (const [k, v] of Object.entries(c.stop_rules || {})) if (v === null || v === undefined) errs.push(`stop_rules.${k} is unset`);
    // A paired trial needs every arm's route verified (KAN-113: arm A smoke-tested, arm B unverified)
    for (const [arm, r] of Object.entries(c.arm_routes || {})) if (!r || r.status === 'unverified') errs.push(`arm ${arm} route is unverified: review and verify it before any paired trial`);
    if (!c.arm_routes || !c.arm_routes.A || !c.arm_routes.B) errs.push('arm_routes must describe arms A and B');
  }
  return errs;
}
