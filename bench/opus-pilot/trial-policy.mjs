/**
 * KAN-112 amendment 1 (review 10599): the arm-trial clock, trial outcome classification and slot accounting.
 * Pure functions; the live runner wires these in. No model, no credentials, no I/O.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../lib/sandbox/agent-profile.js');

const CREDENTIAL_KEY = /(api[_-]?key|token|secret|password|credential|oauth|auth[_-]?header)/i;
const EXPECT = { coding_s: 1800, sign_in_max_s: 600, trial_total_s: 5400 };
const keys = (o, at = '') => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [...(CREDENTIAL_KEY.test(k) ? [`${at}${k}`] : []), ...keys(v, `${at}${k}.`)]) : []);

/** Refuse an amendment whose base, references, caps or attempts differ from what 10599 accepted. */
export function checkAmendment(a, baseBytes) {
  const e = [];
  if (!a || a.schema !== 'qb-opus-pilot-amendment/1') e.push('schema must be qb-opus-pilot-amendment/1');
  if (a.approved_by !== 10599) e.push('approved_by must be 10599');
  if (JSON.stringify(a.references) !== JSON.stringify([10583, 10586])) e.push('references must be [10583, 10586]');
  if (crypto.createHash('sha256').update(baseBytes).digest('hex') !== a.base_sha256) e.push('base config hash differs from the frozen config the amendment was reviewed against');
  for (const [k, v] of Object.entries(EXPECT)) if (!a.time || a.time[k] !== v) e.push(`time.${k} must be ${v}`);
  if (!a.time || a.time.cleanup_runs_after_deadline !== true) e.push('time.cleanup_runs_after_deadline must be true');
  if (JSON.stringify(a.attempts) !== JSON.stringify({ A: 1, E: 3 })) e.push('attempts must be {A:1, E:3}');
  for (const k of keys(a)) e.push(`credential-like key ${k} is not allowed`);
  return e;
}

/** One clock per arm-trial, started before the first setup or sign-in. */
export class TrialClock {
  constructor(a, { startMs, preparationMs = 0 }) {
    this.start = startMs; this.totalMs = a.time.trial_total_s * 1000; this.signInMax = a.time.sign_in_max_s * 1000;
    this.codingMs = a.time.coding_s * 1000; this.codingUsed = 0; this.preparationMs = preparationMs; this.human = {};
  }
  remainingMs(now) { return Math.max(0, this.totalMs - (now - this.start)); }
  stageBudgetMs(stage, requestedMs, now) { return stage === 'cleanup' ? requestedMs : Math.min(requestedMs, this.remainingMs(now)); }
  signInBudgetMs(now) { return this.codingUsed >= this.codingMs ? 0 : Math.min(this.signInMax, this.remainingMs(now)); }
  codingBudgetMs(now) { return Math.min(Math.max(0, this.codingMs - this.codingUsed), this.remainingMs(now)); }
  debitCoding(ms) { this.codingUsed += ms; }
  recordHuman(kind, ms) { this.human[kind] = (this.human[kind] || 0) + ms; }
  mustRunCleanup() { return true; }
  report(now) { return { coding_ms: this.codingUsed, total_elapsed_ms: now - this.start, preparation_ms: this.preparationMs, human_ms: { ...this.human } }; }
}

const PRECEDENCE = ['policy_violation', 'usage_limit', 'auth_timeout', 'infra_interruption', 'pipeline_total_timeout', 'coding_timeout', 'incomplete_evidence', 'execution_verified'];

/**
 * @param {object} t { attempts:[{stream, dropped, sandboxState}], signIn?:{timedOut}, hostFailure?:{kind,stage},
 *                     totalDeadline?:{hit,stage}, patchCaptured?, graderOutcome? }
 */
export function classifyTrial(t, profile) {
  const flags = new Set(); const reasons = []; let cause = null;
  for (const at of t.attempts || []) {
    const c = P.classifyAttempt({ stdout: at.stream, dropped: at.dropped || 0, sandboxState: at.sandboxState || 'completed' }, profile);
    for (const f of c.flags) flags.add(f); reasons.push(...c.reasons);
  }
  if (!(t.attempts || []).length) { flags.add('incomplete_evidence'); reasons.push('no attempt evidence'); }
  if (t.signIn && t.signIn.timedOut) { flags.add('auth_timeout'); cause = cause || { kind: 'auth', stage: 'sign_in' }; }
  if (t.hostFailure) { flags.add('infra_interruption'); cause = cause || { kind: t.hostFailure.kind, stage: t.hostFailure.stage || null }; }
  if (t.totalDeadline && t.totalDeadline.hit) { flags.add('pipeline_total_timeout'); cause = cause || { kind: 'total_deadline', stage: t.totalDeadline.stage }; }
  const evidenceOk = !flags.has('incomplete_evidence') && !flags.has('policy_violation');
  flags.delete('verified');                       // per-attempt "verified" = nothing else applied
  if (!flags.size) flags.add('execution_verified');
  const primary = PRECEDENCE.find((p) => flags.has(p));
  const interrupted = ['policy_violation', 'usage_limit', 'auth_timeout', 'infra_interruption', 'pipeline_total_timeout'].includes(primary);
  const patch_use = !t.patchCaptured ? 'none' : ['coding_timeout', 'execution_verified'].includes(primary) ? 'grade_under_10583' : 'diagnostic_only';
  return { primary, flags: [...flags].sort(), reasons, cause, execution_evidence: evidenceOk ? 'verified' : 'not_verified',
    grader_outcome: t.graderOutcome || null, patch_use, valid_completed_trial: !interrupted && primary !== 'incomplete_evidence' };
}

const INTERRUPTIONS = new Set(['usage_limit', 'auth_timeout', 'infra_interruption', 'pipeline_total_timeout', 'policy_violation']);
const PAIRABLE = new Set(['execution_verified', 'coding_timeout']);

/** Every assigned slot stays visible; reruns need an approval id and keep the original. */
export function accountSlots(slots) {
  const byOutcome = {}; const latest = new Map(); let reruns = 0;
  slots.forEach((s, i) => {
    byOutcome[s.primary] = (byOutcome[s.primary] || 0) + 1;
    if (s.rerun_of !== undefined) {
      if (!Number.isInteger(s.rerun_approved_by)) throw new Error(`slot ${i}: a rerun needs a reviewer approval id`);
      reruns++;
    }
    latest.set(`${s.task}\u0000${s.arm}`, s);
  });
  const firsts = slots.filter((s) => s.rerun_of === undefined);
  const refused = firsts.filter((s) => s.primary === 'preflight_refused').length;
  const tasks = new Set(slots.map((s) => s.task));
  let pairs = 0; for (const t of tasks) { const a = latest.get(`${t}\u0000A`); const b = latest.get(`${t}\u0000B`); if (a && b && PAIRABLE.has(a.primary) && PAIRABLE.has(b.primary)) pairs++; }
  return { assigned: firsts.length, refused, executed: firsts.length - refused, interrupted: firsts.filter((s) => INTERRUPTIONS.has(s.primary)).length,
    execution_valid_pairs: pairs, reruns, by_outcome: byOutcome, slots: slots.map((s) => ({ ...s })) };
}
