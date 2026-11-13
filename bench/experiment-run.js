#!/usr/bin/env node
/**
 * bench/experiment-run.js — run an experiment (QB-28): every planned (trial, arm) through
 * the one arm API (bench/arms.js), every arm graded by the same external grader
 * (bench/grader.js), every result recorded immutably (bench/experiment.js).
 *
 *   node bench/experiment-run.js --config <experiment-config.json> [--out bench/experiments]
 *   node bench/experiment-run.js --config <cfg> --resume <experiment dir> [--shard i/n]
 *
 * --resume runs an experiment that is already pinned (its manifest is never rewritten; its
 * pins are re-checked before every arm-trial as always). --shard i/n runs only the WHOLE tasks
 * of shard i (sorted task ids, round-robin), so parallel machines can each fill their part of
 * ONE pinned experiment and the recorded trials are merged afterwards (QB-30 dev pilot).
 *
 * Config: { kind, specs: [<spec file>…], arms: ["A","E",…], primary: ["A","E"], repetitions,
 *   budget: { agent_time_ms, trial_deadline_ms, model_call_deadline_ms }, seed?, order?,
 *   memory_start?: <dir>, protocol?: { path }, approval? }
 *
 * Each arm-trial: a fresh checkout of the spec's pinned base, its own run record, its own
 * budget run with the per-trial deadline, then the grader. An arm that throws is recorded
 * with its status (timeout / infra_error) — attrition is never dropped.
 */

const fs = require('fs');
const path = require('path');
const { createWorkspace } = require('../lib/workspace');
const runStore = require('../run/store');
const budget = require('../lib/budget');
const { AGENT_VERSION } = require('../lib/sandbox/agent');
const { pinExperiment, recordTrial, readManifest, preflight } = require('./experiment');
const { ARMS, SCOPE, runArm } = require('./arms');
const D = require('../lib/sandbox/docker');
const { seededOrder, holdoutGate } = require('./plan');
const { grade, GRADER_FILES } = require('./grader');
const { checkFrozen, readLock, LOCK_FILE } = require('./spec');
const S = require('./schemas');
const TP = require('../lib/pilot/trial-policy');

const AGENT = { type: 'claude-code', version: AGENT_VERSION, isolation: 'sandbox' };

/** Manifest task entries for frozen specs. */
function taskEntries(specs) {
  return specs.map((s) => ({ id: s.id, version: s.version, spec_sha256: S.specHash(s), split: s.split, repo_commit: s.repo.base_rev, lockfiles: s.repo.lockfiles,
    stratum: { type: s.stratum.type, repository: s.stratum.repository } }));
}

/** The exact arm definitions (bench/arms.js) — a manifest cannot redefine an arm. */
function armDefinitions(ids) {
  return ids.map((id) => { if (!ARMS[id]) throw new Error(`unknown arm ${id}`); return { ...ARMS[id] }; });
}

/**
 * The task set an experiment config uses: `lock` (its spec lock) and `suites` (its hidden suites),
 * relative to the config file. Defaults: the dev set's lock and the grader's default suites.
 */
function configPaths(cfg, cfgFile) {
  const rel = (p) => path.resolve(path.dirname(cfgFile), p);
  return { lockFile: cfg.lock ? rel(cfg.lock) : LOCK_FILE, suitesRoot: cfg.suites ? rel(cfg.suites) : null };
}

/** "i/n" with 1 ≤ i ≤ n → { index, count }. */
function parseShard(v) {
  const m = /^(\d+)\/(\d+)$/.exec(String(v || ''));
  const index = m ? Number(m[1]) : NaN; const count = m ? Number(m[2]) : NaN;
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`--shard must be i/n with 1 ≤ i ≤ n (got "${v}")`);
  return { index, count };
}

/** Whole tasks per shard: sorted task ids, round-robin. → { 1: [ids…], …, n: [ids…] } */
function taskShards(taskIds, count) {
  const out = {};
  for (let i = 1; i <= count; i++) out[i] = [];
  [...taskIds].sort().forEach((id, k) => out[(k % count) + 1].push(id));
  return out;
}

/** Map the honest qb-usage/1 record onto the trial's usage (unknown stays unknown). */
function trialUsage(u, agentMs) {
  const m = u.model;
  // Every arm runs the coding agent, which reports no tokens (QB-21), so a trial's total
  // tokens are unknown; QB's own model tokens, when reported, stay in usage.json.
  const tokens = 'unknown';
  const returned = Object.keys(m.models_reported).map((name) => ({ role: 'qb-model', requested: m.configured, returned: name }));
  if (m.attempted > 0 && !returned.length) returned.push({ role: 'qb-model', requested: m.configured, returned: 'unknown' });
  returned.push({ role: 'agent', requested: 'claude-code', returned: 'unknown' });
  return {
    agent_ms: agentMs,
    model_calls: m.attempted,
    tokens,
    cost_usd: u.cost.total.usd === null ? 'unknown' : u.cost.total.usd,
    human_approval_ms: 'unknown',             // the oracle was approved when the spec was frozen; not timed
    models_returned: returned,
  };
}

/**
 * Run every planned trial/arm of an experiment that is not yet recorded.
 * @param {string} expDir
 * @param {object} o  { specs: { [taskId]: spec }, memoryStart?: dir, runsDir?, runSandboxed?, grader?: {…}, deps? }
 */
async function runExperiment(expDir, o) {
  const m = readManifest(expDir);
  // QB-29: bind the pins to execution — on every run AND resume, before any agent work.
  // Drift (code, dirty state, images, agent/model config, Node, grader) is refused. It is
  // checked again before EVERY arm-trial below (re-review 2), not only here.
  // QB-30: holdout tasks run only under a hash-matched independent approval (official only).
  holdoutGate(m, { qbRoot: o.qbRoot });
  await preflight(m, o.preflight || {});
  for (const t of m.tasks) {
    const spec = o.specs[t.id];
    if (!spec || S.specHash(spec) !== t.spec_sha256) throw new Error(`spec for ${t.id} does not match the manifest`);
  }
  for (const a of m.arms) {
    if (S.hashOf(a) !== S.hashOf(ARMS[a.id])) throw new Error(`arm ${a.id} in the manifest differs from the arm table`);
  }
  if (o.memoryStart ? S.treeHash(o.memoryStart) !== m.memory.starting_store_sha256 : m.memory.starting_store_sha256 !== null) {
    throw new Error('starting memory store does not match the manifest');
  }
  // KAN-112 10603: a pilot experiment must pin the reviewed amendment and pass its gate before ANY arm-trial.
  const pilot = pilotSetup(m, o);
  const results = [];
  // QB-30: a shard runs only its whole tasks; the rest of the plan is left to the other shards.
  const mine = o.shard ? new Set(taskShards(m.tasks.map((t) => t.id), o.shard.count)[o.shard.index]) : null;
  for (const p of m.trial_plan.order) {
    if (mine && !mine.has(p.task_id)) continue;
    if (fs.existsSync(path.join(expDir, 'trials', p.trial_id, p.arm, 'result.json'))) continue;   // recorded
    const spec = o.specs[p.task_id];
    // QB-29 re-review 2: this arm-trial's own runtime identity — observed now, drift refused
    // (an identity change after an earlier trial stops the experiment before this one runs).
    const runtime = await preflight(m, o.preflight || {});
    // Every container this trial creates (arm AND grading) launches from the pinned immutable
    // image ids, and each created container's image is verified before it starts.
    const release = D.bindImages(Object.fromEntries(Object.values(runtime.image_ids || {}).map((x) => [x.ref, x.id])));
    let launched = []; let g = null; let pt = null;
    const started = new Date();
    let ws = null; let run = null; let out; let usage = null;
    try {
    // QB-28 re-review: one budget run per arm-trial. trial_deadline_ms covers EVERY stage,
    // external grading included; model_call_deadline_ms is the per-call limit in force.
    // KAN-112 10603: the arm-trial clock starts here, before the first setup or sign-in, and covers every stage.
    pt = pilot ? pilotTrial(pilot, o) : null;
    const budgetRun = budget.startRun({ deadlineMs: pt ? pt.totalMs : m.budget.trial_deadline_ms, agent: AGENT, modelCallMs: m.budget.model_call_deadline_ms });
    if (pt) budgetRun.signal.addEventListener('abort', () => { if (!pt.abortStage) pt.abortStage = pt.stage; });
    try {
      ws = createWorkspace(require('./repos').resolveSource(spec.repo.source), { baseRev: spec.repo.base_rev, label: `${p.task_id}-${p.arm}` });
      run = runStore.createRun({ kind: 'bench-arm', request: spec.prompt, repoPath: ws.dir, baseSha: ws.baseSha, agent: AGENT,
        config: { experiment_id: m.experiment_id, trial_id: p.trial_id, arm: p.arm, task_id: p.task_id }, runsDir: o.runsDir });
      if (pt) pt.stage = 'arm';
      out = await runArm({ arm: p.arm, spec, repoPath: ws.dir, run, budgetRun, baseSha: ws.baseSha, agentTimeMs: pt ? pt.codingMs : m.budget.agent_time_ms,
        ...(agentProfileFromManifest(m) ? { agentProfile: agentProfileFromManifest(m) } : {}),
        ...(pt ? { pilot: pt.hooks, approvedAuthRoutes: o.approvedAuthRoutes } : {}),
        memoryStart: ARMS[p.arm].memory === 'on' ? { store: o.memoryStart || null, sha256: m.memory.starting_store_sha256 } : null,
        runSandboxed: o.runSandboxed, deps: o.deps, signal: budgetRun.signal });
      // The run record keeps QB's own outcome (E/F) — the SCORE is the external grade below.
      if (out.status !== 'completed') run.finish('ERROR', { reason: out.detail || out.status });
      else if (out.internal_verdict) run.finish(runStore.outcomeFor(out.internal_verdict), { legacy_verdict: out.internal_verdict, reason: 'internal verdict; scored by the external grader' });
      else run.finish('UNRESOLVED', { reason: 'no internal verdict (native arm); scored by the external grader' });
    } catch (e) {
      const timedOut = e && (e.code === 'DEADLINE' || /deadline/i.test(String(e.message)));
      out = { status: timedOut ? 'timeout' : 'infra_error', detail: String(e && e.message).slice(0, 500), patch: '', attempts: 0, agent_ms: 0, internal_verdict: null,
        memory: { mode: ARMS[p.arm].memory, store_sha256_before: ARMS[p.arm].memory === 'on' ? m.memory.starting_store_sha256 : null, recall_calls: 0, persist_calls: 0 } };
      if (run) { try { run.abort('ERROR', out.detail); } catch { /* closed */ } }
    } finally {
      if (ws) ws.cleanup();
    }
    // QB-27: the same external grader for every arm; nothing about the arm reaches it.
    // It runs inside the trial's budget run: the trial deadline cancels grading too.
    if (pt) { pt.clock.debitCoding(out.agent_ms || 0); pt.stage = 'grading'; }
    // KAN-112 10603 / 10583: a coding-timeout patch is graded; other interruptions are never graded as valid trials.
    const pre = pt ? pilotClassify(pt, out, null) : null;
    try {
      if (out.status === 'completed' || (pre && pre.primary === 'coding_timeout' && out.patch)) {
        g = await grade({ spec, patch: out.patch, ...(o.grader || {}), sandbox: { ...((o.grader && o.grader.sandbox) || {}), signal: budgetRun.signal } });
        if (budgetRun.interrupted()) out = { ...out, status: 'timeout', detail: `trial deadline (${m.budget.trial_deadline_ms} ms) reached during external grading` };
      }
    } finally {
      usage = { ...budgetRun.usage(), arm_timing: out.timing || [] };   // agent stage vs whole invocation, per attempt
      budget.endRun();
    }
    } finally {
      launched = release();
    }
    const finished = new Date();
    // The trial's runtime evidence: its own preflight identity plus every container it actually launched.
    const artifacts = { 'patch.diff': out.patch || '', 'usage.json': usage, 'runtime.json': { ...runtime, launched } };
    if (pt) artifacts['pilot.json'] = pilotRecord(pt, out, g, p, pilot);
    if (g) artifacts['grade.json'] = g;
    if (run) artifacts['run.json'] = { run_id: run.id, outcome: run.manifest.outcome, attempts: run.manifest.attempts.length };
    results.push(recordTrial(expDir, {
      experiment_id: m.experiment_id, trial_id: p.trial_id, task_id: p.task_id, repetition: p.repetition, arm: p.arm,
      status: out.status, ...(out.detail ? { detail: out.detail } : {}),
      started_at: started.toISOString(), finished_at: finished.toISOString(), elapsed_ms: finished - started,
      internal_verdict: out.internal_verdict ?? null, grade_outcome: g ? g.outcome : null,
      usage: trialUsage(usage, out.agent_ms || 0), memory: out.memory,
    }, artifacts));
  }
  return results;
}

async function main(argv) {
  const { program } = require('commander');
  program.name('experiment-run').requiredOption('--config <file>').option('--out <dir>', 'experiments root', path.join(__dirname, 'experiments'))
    .option('--pin-only', 'pin the experiment (manifest) and stop: no trials run')
    .option('--resume <dir>', 'run an already pinned experiment (no new manifest)').option('--shard <i/n>', 'run only the whole tasks of shard i of n').parse(argv);
  const opts = program.opts();
  const shard = opts.shard ? parseShard(opts.shard) : null;
  const cfgFile = path.resolve(opts.config);
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const specs = (cfg.specs || []).map((f) => JSON.parse(fs.readFileSync(path.resolve(path.dirname(cfgFile), f), 'utf8')));
  const sets = configPaths(cfg, cfgFile);
  const lock = readLock(sets.lockFile);
  for (const s of specs) checkFrozen(s, lock);
  const grader = sets.suitesRoot ? { suitesRoot: sets.suitesRoot } : undefined;
  const protocol = cfg.protocol ? { path: cfg.protocol.path, sha256: S.sha256File(path.resolve(path.dirname(cfgFile), cfg.protocol.path)) } : null;
  const memoryStart = cfg.memory_start ? path.resolve(path.dirname(cfgFile), cfg.memory_start) : null;
  if (opts.resume) {
    const dir = path.resolve(opts.resume);
    console.log(`experiment ${dir} (resume${shard ? `, shard ${shard.index}/${shard.count}` : ''})`);
    await runExperiment(dir, { specs: Object.fromEntries(specs.map((s) => [s.id, s])), memoryStart, shard, grader });
    console.log(`done — report: node bench/report.js ${dir}`);
    return;
  }
  const { dir } = await pinExperiment({
    dir: path.resolve(opts.out), kind: cfg.kind, tasks: taskEntries(specs), arms: armDefinitions(cfg.arms),
    primary_comparison: cfg.primary, budget: { ...cfg.budget, total_compute_controlled: false },
    repetitions: cfg.repetitions || 1, seed: cfg.seed || 'none',
    // QB-30: a seeded, randomized, paired order unless the config gives one explicitly
    order: cfg.order || (cfg.seed ? seededOrder(taskEntries(specs), armDefinitions(cfg.arms), cfg.repetitions || 1, cfg.seed) : undefined), config: { ...cfg, scope: SCOPE }, protocol, approval: cfg.approval || null,
    memory: { starting_store_sha256: memoryStart ? S.treeHash(memoryStart) : null }, graderFiles: GRADER_FILES,
    models: [{ role: 'qb-model', requested: process.env.QB_MODEL || 'deepseek-r1:7b' }],
  });
  console.log(`experiment ${dir}`);
  if (opts.pinOnly) return;
  await runExperiment(dir, { specs: Object.fromEntries(specs.map((s) => [s.id, s])), memoryStart, shard, grader });
  console.log(`done — report: node bench/report.js ${dir}`);
}

if (require.main === module) main(process.argv).catch((e) => { console.error(`experiment-run: ${e.message}`); process.exit(1); });

/** KAN-112 10603: gate + setup for a pilot experiment; null for a non-pilot one. */
function pilotSetup(m, o) {
  if (!agentProfileFromManifest(m)) return null;
  const g = TP.pilotGate(m);
  if (g.problems.length) throw new Error(`pilot gate (KAN-112 amendment): ${g.problems.join('; ')}`);
  const seam = typeof o.runSandboxed === 'function';
  // No real sign-in is implemented or approved: a pilot runs only with a FAKE adapter under the test sandbox seam.
  if (!seam || typeof o.signInAdapter !== 'function') throw new Error('pilot run refused: no approved sign-in implementation (a fake sign-in adapter is accepted only with the test sandbox seam)');
  // test seam only: shrinks the TOTAL and SIGN-IN windows so deadline cases run in seconds; the coding budget is never scaled
  const scale = typeof o.timeScale === 'number' && o.timeScale > 0 && o.timeScale <= 1 ? o.timeScale : 1;
  return { amendment: g.amendment, sha256: g.sha256, scale, totalMs: Math.round(m.budget.trial_deadline_ms * scale), codingMs: m.budget.agent_time_ms };
}

/** One arm-trial's clock, attempt recorder and sign-in hook. */
function pilotTrial(pilot, o) {
  const a = pilot.amendment; const k = pilot.scale;
  const scaled = { ...a, time: { ...a.time, sign_in_max_s: a.time.sign_in_max_s * k, trial_total_s: a.time.trial_total_s * k } };
  const pt = { clock: new TP.TrialClock(scaled, { startMs: Date.now(), preparationMs: 0 }), attempts: [], stage: 'setup', abortStage: null,
    totalMs: pilot.totalMs, codingMs: pilot.codingMs, signIns: 0, signInTimeouts: 0 };
  pt.hooks = {
    record: (x) => pt.attempts.push(x),
    onStage: (st) => { pt.stage = st; },
    signIn: async ({ signal }) => {
      const budgetMs = pt.clock.signInBudgetMs(Date.now()); pt.signIns++;
      if (budgetMs <= 0) { pt.signInTimeouts++; return { status: 'timeout' }; }
      const t0 = Date.now(); let timer;
      const r = await Promise.race([
        Promise.resolve(o.signInAdapter({ budgetMs, signal })).catch(() => ({ status: 'error' })),
        new Promise((res) => { timer = setTimeout(() => res({ status: 'timeout' }), budgetMs); }),
      ]);
      clearTimeout(timer); pt.clock.recordHuman('sign_in', Date.now() - t0);
      if (r.status === 'timeout') pt.signInTimeouts++;
      return r;
    },
  };
  return pt;
}

function pilotClassify(pt, out, g) {
  const hostFailure = pt.attempts.find((x) => x.host_failure) || (!pt.abortStage && out.status === 'infra_error' && !pt.attempts.length ? { stage: pt.stage } : null);
  return TP.classifyTrial({
    attempts: pt.attempts.filter((x) => !x.host_failure),
    hostFailure: hostFailure ? { kind: 'host', stage: hostFailure.stage || 'agent' } : null,
    totalDeadline: pt.abortStage ? { hit: true, stage: pt.abortStage } : null,
    patchCaptured: Boolean(out.patch), graderOutcome: g ? g.outcome : null,
  }, null);
}

function pilotRecord(pt, out, g, p, pilot) {
  const c = pilotClassify(pt, out, g);
  return { schema: 'qb-pilot-trial/1', amendment_sha256: pilot.sha256, time_scale: pilot.scale,
    slot: { trial_id: p.trial_id, task_id: p.task_id, repetition: p.repetition, arm: p.arm, pilot_arm: p.arm === 'E' ? 'B' : p.arm },
    primary: c.primary, flags: c.flags, reasons: c.reasons.slice(0, 20), cause: c.cause, execution_evidence: c.execution_evidence,
    grader_outcome: c.grader_outcome, grade_use: g ? (c.patch_use === 'grade_under_10583' ? 'valid' : 'diagnostic') : 'not_graded',
    patch_use: c.patch_use, valid_completed_trial: c.valid_completed_trial,
    attempts: pt.attempts.map((x) => ({ flags: x.flags, sandbox_state: x.sandbox_state || null })), sign_ins: pt.signIns,
    effort: pt.clock.report(Date.now()) };
}

/** KAN-113: the pilot agent profile pinned in the manifest's config (same profile for every arm), or null. */
function agentProfileFromManifest(m) {
  const p = m && m.config && m.config.agent_profile;
  return p && typeof p === 'object' ? p : null;
}

module.exports = { runExperiment, taskEntries, armDefinitions, trialUsage, parseShard, taskShards, configPaths, agentProfileFromManifest };
