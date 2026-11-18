/**
 * lib/budget.js — deadlines, cancellation and usage for one run (QB-21).
 *
 *   per-call deadline   every local-model call ends after QB_MODEL_CALL_TIMEOUT_MS
 *                       (default 180 s) — even if the transport ignores the abort
 *                       signal: the call is raced against its deadline.
 *   total-run deadline  startRun({ deadlineMs }) (qb.js: QB_RUN_DEADLINE_MS / --deadline)
 *                       aborts the run's signal; in-flight and later model calls fail
 *                       with "run deadline (…) exceeded during <stage>", and the stage
 *                       that was interrupted is recorded.
 *   concurrency         at most QB_MODEL_CONCURRENCY (default 2) model calls at once.
 *   usage               (re-review) an honest record: stage times; model calls attempted /
 *                       completed / failed / timed out / cancelled; tokens only when reported
 *                       (unknown is null, never 0; partial coverage labelled); reported model
 *                       ids and endpoints; agent identity with its usage explicitly unknown;
 *                       effective deadlines; cost with provenance or explicit unknown; and the
 *                       budgets that are not enforced.
 *
 * One run is active per process (qb.js / the benchmark start and end it). Without an
 * active run, calls still get the per-call deadline and the concurrency bound.
 */

const envInt = (name, dflt) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : dflt; };
const callTimeoutMs = () => envInt('QB_MODEL_CALL_TIMEOUT_MS', 180_000);
/** The per-call deadline in force: the active run's own (QB-28 manifests), else the environment's. */
const effectiveCallMs = (runMs) => runMs || callTimeoutMs();
const concurrency = () => envInt('QB_MODEL_CONCURRENCY', 2);

/**
 * KAN-106 (senior 10674 F-d): L1 time profiles. EXPERIMENTAL and opt-in only (--l1-profile or
 * QB_L1_PROFILE): not a beta SLA and not a global default. One successful smoke cannot establish
 * that a 420 s wait is acceptable to a customer.
 */
const L1_PROFILES = Object.freeze({
  'qwen-14b-experimental': Object.freeze({ per_call_ms: 240_000, l1_ms: 420_000, experimental: true,
    note: 'experimental profile for qwen2.5-coder:14b-class local models (KAN-106, 10674); not a beta SLA or a default' }),
  // KAN-106 (owner priority after 10733): the same budget, but L1 runs the STAGED compiler
  // (intent/staged.js): small schema-constrained fact calls, deterministic assembly. Offline prototype.
  'qwen-14b-staged': Object.freeze({ per_call_ms: 240_000, l1_ms: 420_000, experimental: true, staged: true,
    note: 'experimental STAGED L1 compiler prototype (KAN-106, option B of 10733): per-requirement JSON-schema fact calls, deterministic assembly; not a beta SLA or a default' }),
});

/**
 * KAN-106: the L1 (intent) time budget, recorded in the run with the measured L1 timings (qb.js
 * event `l1.timings`). Precedence: --l1-budget <seconds>, then QB_L1_BUDGET_MS, then an explicit
 * profile's total, then a PROVISIONAL default of two per-call deadlines (one draft plus the one
 * automatic repair, KAN-103).
 * Since 10674 an EXPLICIT budget (flag, env or profile) is ENFORCED with a monotonic deadline over
 * all of L1 (lib/budget.js l1Deadline; intent/session.js); the provisional default stays recorded
 * only, so behaviour without an explicit choice is unchanged. A profile also sets the per-call cap
 * for L1 calls (otherwise the per-call deadline in force applies).
 * @returns {{ ms, source, enforced, per_call_ms, profile }}
 */
function l1Budget({ flagMs = 0, profile = null } = {}) {
  const name = profile || process.env.QB_L1_PROFILE || null;
  const p = name ? L1_PROFILES[name] : null;
  if (name && !p) throw new Error(`unknown L1 profile ${JSON.stringify(name)} (known: ${Object.keys(L1_PROFILES).join(', ')})`);
  const perCall = p ? p.per_call_ms : effectiveCallMs(active && active.modelCallMs);
  const out = (ms, source, enforced) => ({ ms, source, enforced, per_call_ms: perCall, profile: p ? name : null });
  if (Number.isInteger(flagMs) && flagMs > 0) return out(flagMs, '--l1-budget', true);
  const env = Number(process.env.QB_L1_BUDGET_MS);
  if (process.env.QB_L1_BUDGET_MS && Number.isInteger(env) && env > 0) return out(env, 'env QB_L1_BUDGET_MS', true);
  if (p) return out(p.l1_ms, `profile ${name}`, true);
  return out(2 * perCall, 'provisional_default', false);
}

/** Monotonic milliseconds (never jumps with the wall clock). */
const monotonicMs = () => performance.now();

class DeadlineError extends Error {
  constructor(message, { stage = null, kind = 'call' } = {}) { super(message); this.name = 'DeadlineError'; this.code = 'DEADLINE'; this.stage = stage; this.kind = kind; }
}

// ── the active run ──
let active = null;

function newUsage() {
  return { stages: [], model: { attempted: 0, completed: 0, failed: 0, timed_out: 0, cancelled: 0,
    calls_reporting: 0, calls_not_reporting: 0, prompt: 0, completion: 0, models_reported: {}, endpoints: {} } };
}

const AGENT_USAGE_REASON = 'the sandboxed agent runs `claude -p --output-format text`, which reports no token usage or cost to QB';
const UNSUPPORTED = [
  'token budget: not enforced (model tokens are recorded when reported, never capped)',
  'cost budget: not enforced (agent cost is not reported to QB)',
  'agent token usage: unknown (' + AGENT_USAGE_REASON + ')',
];
const isLocal = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

/**
 * The honest usage record (QB-21 re-review): unknown is null with a reason, never 0.
 * Model tokens: `complete` (every completed call reported counts), `partial` (sums cover only
 * the reporting calls), `unknown` (none reported), `none` (no completed calls).
 */
function usageRecord(u, { deadlineMs, agent, sandboxDeadlines, modelCallMs = callTimeoutMs() }) {
  const m = u.model;
  const tokensStatus = m.completed === 0 ? 'none' : m.calls_not_reporting === 0 ? 'complete' : m.calls_reporting === 0 ? 'unknown' : 'partial';
  const known = tokensStatus === 'complete' || tokensStatus === 'partial';
  const hosts = Object.keys(m.endpoints);
  const models = Object.keys(m.models_reported);
  const allLocal = hosts.length > 0 && hosts.every(isLocal) && !models.some((x) => /-cloud$|:cloud$/.test(x));
  const modelCost = m.attempted === 0 ? { usd: 0, status: 'none', basis: 'no model calls' }
    : allLocal ? { usd: 0, status: 'estimated', basis: 'local Ollama inference: no per-call charge (hardware and energy are not metered)' }
      : { usd: null, status: 'unknown', basis: 'remote or cloud model endpoint: billing is not visible to QB' };
  const agentKind = agent && agent.type;
  const agentApplies = agentKind && !['dry-run', 'manual'].includes(agentKind);
  const agentUsage = agentApplies
    ? { identity: agent, usage_status: 'unknown', tokens: null, cost_usd: null, reason: AGENT_USAGE_REASON }
    : { identity: agent || null, usage_status: 'not_applicable', tokens: null, cost_usd: 0, reason: agentKind ? `${agentKind}: no coding-agent model calls` : 'no agent' };
  const agentCost = agentApplies ? { usd: null, status: 'unknown', basis: AGENT_USAGE_REASON } : { usd: 0, status: 'none', basis: agentUsage.reason };
  const total = modelCost.usd !== null && agentCost.usd !== null
    ? { usd: modelCost.usd + agentCost.usd, status: modelCost.status === 'estimated' ? 'estimated' : 'none' }
    : { usd: null, status: 'unknown', basis: 'at least one component is unknown' };
  return {
    schema: 'qb-usage/1',
    deadlines: { run_ms: deadlineMs > 0 ? deadlineMs : null, model_call_ms: modelCallMs, model_concurrency: concurrency(), sandbox_stage_ms: sandboxDeadlines || null },
    stages: u.stages,
    model: {
      configured: process.env.QB_MODEL || 'deepseek-r1:7b',
      models_reported: m.models_reported, endpoints: m.endpoints,
      attempted: m.attempted, completed: m.completed, failed: m.failed, timed_out: m.timed_out, cancelled: m.cancelled,
      tokens: { status: tokensStatus, prompt: known ? m.prompt : null, completion: known ? m.completion : null,
        calls_reporting: m.calls_reporting, calls_not_reporting: m.calls_not_reporting },
    },
    agent: agentUsage,
    cost: { model: modelCost, agent: agentCost, total },
    unsupported: UNSUPPORTED,
  };
}

/**
 * @param {object} [o]
 * @param {number} [o.modelCallMs] QB-28 re-review: this run's per-call model deadline (an
 *   experiment manifest's model_call_deadline_ms); overrides QB_MODEL_CALL_TIMEOUT_MS while
 *   the run is active, and is what the usage record reports.
 */
function startRun({ deadlineMs = 0, agent = null, sandboxDeadlines = null, modelCallMs = null } = {}) {
  const controller = new AbortController();
  const usage = newUsage();
  let current = null;
  let interrupted = null;
  let timer = null;
  const closeStage = () => { if (current) { current.ms = Date.now() - current.t0; delete current.t0; current = null; } };
  if (deadlineMs > 0) {
    timer = setTimeout(() => {
      interrupted = { stage: current ? current.stage : null, deadline_ms: deadlineMs };
      controller.abort(new DeadlineError(`run deadline (${deadlineMs}ms) exceeded during ${interrupted.stage || 'startup'}`, { stage: interrupted.stage, kind: 'run' }));
    }, deadlineMs);
    timer.unref();
  }
  const runCallMs = Number.isInteger(modelCallMs) && modelCallMs > 0 ? modelCallMs : null;
  const deadlineAt = deadlineMs > 0 ? monotonicMs() + deadlineMs : null;
  active = {
    /** KAN-106: what is left of the run deadline (Infinity without one): an enclosing bound for L1 calls. */
    remainingMs: () => (deadlineAt === null ? Infinity : Math.max(0, deadlineAt - monotonicMs())),
    modelCallMs: runCallMs,
    signal: controller.signal,
    counters: usage,
    stage(name) { closeStage(); current = { stage: String(name), t0: Date.now() }; usage.stages.push(current); },
    interrupted: () => interrupted,
    cancel(reason) { if (!controller.signal.aborted) controller.abort(new DeadlineError(reason, { stage: current && current.stage, kind: 'cancel' })); },
    usage: () => {
      const out = JSON.parse(JSON.stringify(usage));
      const open = out.stages.find((s) => s.t0 !== undefined);
      if (open) { open.ms = Date.now() - open.t0; delete open.t0; }
      return usageRecord(out, { deadlineMs, agent, sandboxDeadlines, modelCallMs: effectiveCallMs(runCallMs) });
    },
    end() { closeStage(); if (timer) clearTimeout(timer); },
  };
  return active;
}
function endRun() { if (active) active.end(); active = null; }
/** Throws the run's cancellation reason if the run deadline has passed (between stages). */
function checkpoint() { if (active && active.signal.aborted) throw active.signal.reason; }
const currentRun = () => active;

// ── bounded concurrency for local-model calls ──
let inFlight = 0;
const waiting = [];
async function acquire(signal) {
  while (inFlight >= concurrency()) {
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      waiting.push(entry);
      if (signal) signal.addEventListener('abort', () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); }, { once: true });
    });
  }
  inFlight++;
}
function release() { inFlight--; const next = waiting.shift(); if (next) next.resolve(); }

/**
 * One deadline-bound, cancellable, concurrency-bounded JSON POST to the local model.
 * Resolves the parsed JSON body; throws DeadlineError on a per-call timeout or when the
 * run is cancelled, and a plain Error on an HTTP error.
 * KAN-106 (10674 F-d): `o.callMs` replaces the per-call deadline for this call (an L1 profile's
 * cap) and `o.capMs` bounds it further (what is left of the L1 budget). The call's limit is
 * min(per-call, capMs, the run deadline's remaining time). When capMs is the binding limit, the
 * timeout is a DeadlineError of kind 'l1' with `o.capMessage`.
 */
async function modelCall(url, body, o = {}) {
  const run = active;
  const perCall = Number.isInteger(o.callMs) && o.callMs > 0 ? o.callMs : effectiveCallMs(run && run.modelCallMs);
  const cap = Number.isFinite(o.capMs) ? Math.max(0, Math.floor(o.capMs)) : Infinity;
  const ms = Math.max(0, Math.min(perCall, cap, run ? Math.ceil(run.remainingMs()) : Infinity));
  const capBinds = cap < perCall && cap <= ms;
  if (typeof o.onLimit === 'function') o.onLimit(ms);
  const mc = run && run.counters.model;
  if (mc) {
    mc.attempted++;
    let host = 'unknown';
    try { host = new URL(url).host; } catch { /* keep unknown */ }
    mc.endpoints[host] = (mc.endpoints[host] || 0) + 1;
  }
  if (run && run.signal.aborted) { mc.cancelled++; throw run.signal.reason; }
  const ctl = new AbortController();
  const onRunAbort = () => ctl.abort(run.signal.reason);
  if (run) run.signal.addEventListener('abort', onRunAbort, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = capBinds ? new DeadlineError(o.capMessage || `L1 budget exhausted after ${ms}ms of this call`, { kind: 'l1' }) : new DeadlineError(`model call timed out after ${ms}ms`);
      ctl.abort(e); reject(e);
    }, ms);
    ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
  });
  deadline.catch(() => {});
  let holding = false;
  const slot = acquire(ctl.signal).then(() => { holding = true; if (ctl.signal.aborted) { holding = false; release(); } });
  slot.catch(() => {});
  try {
    await Promise.race([slot, deadline]);
    try {
      const res = await Promise.race([fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }), deadline]);
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const data = await Promise.race([res.json(), deadline]);
      if (mc) {
        mc.completed++;
        const p = data && data.prompt_eval_count, c = data && data.eval_count;
        if (Number.isInteger(p) && Number.isInteger(c)) { mc.calls_reporting++; mc.prompt += p; mc.completion += c; }
        else mc.calls_not_reporting++;     // unknown is never counted as zero
        if (data && typeof data.model === 'string') mc.models_reported[data.model] = (mc.models_reported[data.model] || 0) + 1;
      }
      return data;
    } finally { if (holding) { holding = false; release(); } }
  } catch (e) {
    if (mc) { if (e && e.code === 'DEADLINE') { if (e.kind === 'call' || e.kind === 'l1') mc.timed_out++; else mc.cancelled++; } else mc.failed++; }
    throw e;
  } finally {
    clearTimeout(timer);
    if (run) run.signal.removeEventListener('abort', onRunAbort);
  }
}

/**
 * KAN-106 (10674 F-d): a monotonic deadline over all of L1. `limits()` gives the next call's
 * { callMs, capMs, capMessage }; `check(step)` throws DeadlineError kind 'l1' once it is spent, so
 * no call (in particular no repair) starts after exhaustion. An unenforced budget never throws.
 */
function l1Deadline(b, now = monotonicMs) {
  const start = now();
  const remaining = () => (b && b.enforced ? Math.max(0, b.ms - (now() - start)) : Infinity);
  const exhausted = (step) => new DeadlineError(`L1 budget (${b.ms}ms, ${b.source}) exhausted ${step}`, { stage: 'L1 intent', kind: 'l1' });
  return {
    budget: b,
    remaining,
    check(step) { if (b && b.enforced && remaining() <= 0) throw exhausted(`before the ${step}`); },
    limits(step) {
      const r = remaining();
      return { callMs: b && b.profile ? b.per_call_ms : undefined, capMs: Number.isFinite(r) ? r : undefined,
        capMessage: b && b.enforced ? `L1 budget (${b.ms}ms, ${b.source}) exhausted during the ${step}` : undefined };
    },
  };
}

module.exports = { startRun, endRun, currentRun, checkpoint, modelCall, DeadlineError, callTimeoutMs, l1Budget, l1Deadline, L1_PROFILES, monotonicMs };
