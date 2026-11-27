/**
 * lib/sandbox/docker.js — the only way the sandbox talks to Docker.
 *
 * Every command is argv (QB-01) and bounded in time: a hung client or daemon
 * is killed after `opTimeoutMs`, never waited on forever (§8.3). Long-running
 * stages use `runStage`, which drains output while the container runs and
 * reads the evidence only after Docker reports it exited (§8.4, §8.5).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runBounded } = require('../proc');
const { classifyStage } = require('./states');

const DOCKER = process.env.QB_DOCKER_BIN || 'docker';
const DEFAULT_OP_TIMEOUT_MS = 30_000;

/** Label set every per-run resource carries, for cleanup and the reaper. */
function runLabels(runId, role) {
  const l = ['--label', `qb.run=${runId}`];
  if (role) l.push('--label', `qb.role=${role}`);
  return l;
}

/**
 * `<repo>:c-<hash>` over every build input (paths relative to `root`; directories
 * walked in sorted order). A changed script or Dockerfile yields a new tag, so an
 * updated QB never runs a stale image built from older trusted code.
 */
function contentTag(repo, root, inputs) {
  const h = crypto.createHash('sha256');
  const add = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs).sort()) add(path.join(rel, e)); return; }
    h.update(`${rel}\0${st.mode & 0o111 ? 'x' : '-'}\0`).update(st.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs)).update('\0');
  };
  for (const i of inputs) add(i);
  return `${repo}:c-${h.digest('hex').slice(0, 16)}`;
}

/** Build `tag` from `buildArgs` unless it already exists. Returns the image id. */
async function ensureImage(tag, buildArgs, what) {
  let r = await op(['image', 'inspect', '-f', '{{.Id}}', tag]);
  if (r.ok) return r.stdout.trim();
  r = await op(['build', '-q', '-t', tag, ...buildArgs], { timeoutMs: 20 * 60_000 });
  if (!r.ok) throw Object.assign(new Error(`${what} image build failed: ${r.stderr.slice(-500)}`), { code: 'IMAGE_BUILD_FAILED' });
  return r.stdout.trim();
}

/** A short, bounded Docker command. Resolves to the runBounded result plus `ok`. */
async function rawOp(args, { timeoutMs = DEFAULT_OP_TIMEOUT_MS, input, raw = false, maxBytes = 1024 * 1024 } = {}) {
  const r = await runBounded(DOCKER, args, { timeoutMs, input, raw, maxBytes });
  return { ...r, ok: r.status === 0 && !r.timedOut };
}

// ── Image binding (QB-29: pins bound to what is actually launched) ─────────────
//
// While a binding is active (one experiment arm-trial, including its grading), every
// container the sandbox creates — `create` (runStage) and `run` (keeper, proxy, probes) —
// is launched from the pinned IMMUTABLE image id, never a mutable tag: a pinned tag in the
// arguments is replaced by its id. Each created container's actual image (.Image) is then
// checked against the pinned ids BEFORE it starts; anything else is removed unstarted and
// the launch fails. Every launch is recorded, so the trial's evidence names what ran.
let binding = null;

/**
 * @param {Record<string,string>} refToId  pinned image ref (tag) → image id (sha256:…)
 * @returns {() => Array<{container, image, ref}>} release: ends the binding, returns the launches
 */
function bindImages(refToId) {
  if (binding) throw new Error('an image binding is already active');
  const b = { map: { ...refToId }, allowed: new Set(Object.values(refToId)), launched: [] };
  binding = b;
  return () => { if (binding === b) binding = null; return b.launched; };
}

const failed = (why, t0) => ({ status: 1, signal: null, stdout: '', stderr: why, timedOut: false, duration_ms: Date.now() - t0, ok: false });

/** Check a created (not started) container's image; remove it unstarted if it is not pinned. */
async function verifyCreated(b, id, ref) {
  const r = await rawOp(['inspect', '-f', '{{.Image}}', id]);
  const image = r.ok ? r.stdout.trim() : null;
  if (!image || !b.allowed.has(image)) {
    await rawOp(['rm', '-f', id]);
    return `image identity: container ${id.slice(0, 12)} was created from ${image || 'an unknown image'}, which is not a pinned image — removed before it ran`;
  }
  b.launched.push({ container: id.slice(0, 12), image, ref: ref || null });
  return null;
}

async function boundLaunch(b, args, opts) {
  const t0 = Date.now();
  const ref = args.find((a) => Object.prototype.hasOwnProperty.call(b.map, a)) || null;
  const rewritten = args.map((a) => (Object.prototype.hasOwnProperty.call(b.map, a) ? b.map[a] : a));
  if (args[0] === 'create') {
    const c = await rawOp(rewritten, opts);
    if (!c.ok) return c;
    const why = await verifyCreated(b, c.stdout.trim(), ref);
    return why ? failed(why, t0) : c;
  }
  // `run` = create (verified) + start: the workload never executes from an unpinned image
  const detached = rewritten.includes('-d');
  const remove = rewritten.includes('--rm');
  const c = await rawOp(['create', ...rewritten.slice(1).filter((a) => a !== '-d' && a !== '--rm')], { timeoutMs: opts.timeoutMs });
  if (!c.ok) return c;
  const id = c.stdout.trim();
  const why = await verifyCreated(b, id, ref);
  if (why) return failed(why, t0);
  if (detached) {
    const st = await rawOp(['start', id]);
    return st.ok ? { ...st, stdout: `${id}\n` } : st;
  }
  try {
    return await rawOp(['start', '-a', ...(opts.input !== undefined ? ['-i'] : []), id], opts);
  } finally {
    if (remove) await rawOp(['rm', '-f', id]);
  }
}

async function op(args, opts = {}) {
  if (binding && (args[0] === 'create' || args[0] === 'run')) return boundLaunch(binding, args, opts);
  return rawOp(args, opts);
}

/** `docker inspect` .State of a container, or null. */
async function inspectState(container) {
  const r = await op(['inspect', '-f', '{{json .State}}', container]);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/**
 * Docker records an OOM kill from a separate containerd event that can be processed
 * after the container's exit. A child OOM-killed under a main process that then exits
 * immediately can therefore inspect as OOMKilled=false for a moment (seen as a CI flake
 * of the OOM classification test). Before trusting OOMKilled=false, re-inspect a few
 * times over ~600 ms so a late OOM event is not missed (QB-02 classification).
 */
async function settleOom(name, state, { tries = OOM_SETTLE_TRIES, delayMs = OOM_SETTLE_DELAY_MS, inspect = inspectState } = {}) {
  let st = state;
  for (let i = 0; i < tries && st && !st.Running && !st.OOMKilled; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const again = await inspect(name);
    if (again) st = again;
  }
  return st;
}
const OOM_SETTLE_TRIES = 3;
const OOM_SETTLE_DELAY_MS = 200;

/** True if the daemon answers within the op timeout. */
async function available() {
  const r = await op(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Ids of every container (or only running ones) for a run, or null when Docker
 * did not answer. Enforcement must use this: "unknown" is not "none running" (G5c).
 */
async function listContainers(runId, { running = false } = {}) {
  const args = ['ps', '-aq', '--filter', `label=qb.run=${runId}`];
  if (running) args.push('--filter', 'status=running');
  const r = await op(args);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
}

/** listContainers, with an unanswered query read as empty (reporting and tests only). */
async function runContainers(runId, opts) {
  return (await listContainers(runId, opts)) || [];
}

// ── KAN-96: supplementary OOM evidence (gate.js, oom-observer.js) ─────────────────
//
// On a host that can see container cgroups (Linux, cgroup v2, local daemon) every stage starts behind the trusted
// gate: the container runs /bin/sh /qb-gate/gate.sh <original command>, the host arms the observer on that exact
// container, then releases the gate. stdin is untouched. If anything about the gate or the observer fails, the
// stage still runs (ungated, or released with the observer not armed) and its evidence says `unavailable` and why.
// Observation is supplementary and fallible: a missed kill is `unavailable`, never "no OOM".

const O = require('./oom-observer');
const { openGate, removeGateDirs, GATE_SCRIPT_PATH, GATE_REFUSED_EXIT } = require('./gate');

const GATE_READY_MS = 30_000;
// `docker create` flags that take no value (everything else in createArgs takes one, or is --flag=value).
const BOOL_FLAGS = new Set(['-i', '--interactive', '-t', '--tty', '--init', '--read-only', '--rm', '-d', '--detach',
  '--privileged', '-P', '--publish-all', '--oom-kill-disable', '--no-healthcheck', '--sig-proxy', '--use-api-socket']);

/** Split `docker create` arguments into flags, image and command. null when the shape is not understood. */
function splitCreateArgs(args) {
  let entrypoint = null;
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string' || a === '--') return null;
    if (!a.startsWith('-') || a === '-') return { flags, image: a, command: args.slice(i + 1), entrypoint };
    if (a.includes('=') && a.startsWith('--')) {
      if (a.startsWith('--entrypoint=')) entrypoint = a.slice('--entrypoint='.length); else flags.push(a);
      continue;
    }
    if (BOOL_FLAGS.has(a)) { flags.push(a); continue; }
    if (i + 1 >= args.length) return null;
    if (a === '--entrypoint') entrypoint = args[i + 1]; else flags.push(a, args[i + 1]);
    i++;
  }
  return null;
}

/**
 * The gated form of `createArgs`, and the exact command the gate must exec. Without an explicit --entrypoint the
 * image's own Entrypoint/Cmd are used, as Docker would (an explicit --entrypoint clears the image's Cmd).
 * @returns {Promise<{ args?: (gate) => string[], argv?: string[], why?: string }>}
 */
async function gatedArgs(createArgs) {
  const s = splitCreateArgs(createArgs);
  if (!s) return { why: 'the stage arguments could not be split into flags, image and command' };
  let argv;
  if (s.entrypoint !== null) argv = [...(s.entrypoint ? [s.entrypoint] : []), ...s.command];
  else {
    const ref = binding && Object.prototype.hasOwnProperty.call(binding.map, s.image) ? binding.map[s.image] : s.image;
    const r = await rawOp(['image', 'inspect', '-f', '{{json .Config}}', ref]);
    let cfg = null;
    try { cfg = r.ok ? JSON.parse(r.stdout) : null; } catch { cfg = null; }
    if (!cfg) return { why: 'the image configuration could not be read' };
    const ep = Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint : [];
    argv = [...ep, ...(s.command.length ? s.command : (Array.isArray(cfg.Cmd) ? cfg.Cmd : []))];
  }
  if (!argv.length || argv.some((x) => typeof x !== 'string')) return { why: 'the stage has no command to gate' };
  return { argv, args: (gate) => [...s.flags, ...gate.mountArgs, '--entrypoint', '/bin/sh', s.image, GATE_SCRIPT_PATH, ...argv] };
}

/** Wait (bounded, backing off) until Docker reports the container running. Stops early if `ended()`. */
async function waitRunning(name, ended, limitMs = GATE_READY_MS) {
  const t0 = Date.now();
  let delay = 5;
  while (!ended() && Date.now() - t0 < limitMs) {
    const st = await inspectState(name);
    if (st && st.Running && Number.isInteger(st.Pid) && st.Pid > 0) return st;
    if (st && !st.Running && st.Status !== 'created') return null;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 100);
  }
  return null;
}

/** The OOM evidence kept in run records: what the observer saw, how, and why it is unavailable if it is. */
function evidenceSummary(ev, rec) {
  const r = rec || {};
  return {
    observer: ev.observer, gate: ev.gate, why: ev.why || r.unavailable || null,
    container: r.container || ev.container || null, cgroup_path: r.path || null,
    baseline: r.baseline ?? null, last: r.last ?? null, final: r.final === true,
    reads: r.reads ?? 0, rereads: r.rereads ?? 0, rereads_capped: Boolean(r.rereads_capped),
    notifications: r.notifications || { memory: 0, cgroup: 0 }, steps: Array.isArray(r.steps) ? r.steps : [],
    arm_ms: r.arm_ms ?? null, observer_active_ms: r.observer_active_ms ?? null, gate_ms: ev.gate_ms ?? null,
  };
}

/**
 * Run one stage container to completion and classify it.
 *
 * `createArgs` are the `docker create` arguments (flags, image, command). The
 * container is created, then started attached so its output streams into
 * bounded buffers; the host-side wait has its own timeout as a backstop.
 * The supervisor (not this function) owns the stage deadline; `killedBy` lets
 * the caller tell classification why the container stopped.
 * `oomObserver` is for tests and the KAN-96 diagnostic only ({ enabled, force, cgroupRoot, procRoot, workerFile,
 * armTimeoutMs, finishTimeoutMs }); product callers pass nothing.
 *
 * @returns {Promise<{ name, state, reason, exit_code, oom_killed, oom_signal, oom_unavailable?, oom_evidence,
 *                     stdout, stderr, stdout_dropped, stderr_dropped, duration_ms }>}
 */
async function runStage(name, createArgs, { input, waitTimeoutMs, maxBytes, killedBy, oomObserver = {} } = {}) {
  const ev = { observer: 'not_used', gate: 'not_used', why: null, container: null, gate_ms: null };
  const support = O.hostSupport(oomObserver);
  let gate = null;
  let obs = null;
  let args = createArgs;
  let argv = null;
  if (!support.ok) ev.why = support.why;
  else {
    try {
      const plan = await gatedArgs(createArgs);
      if (!plan.args) ev.why = `not gated: ${plan.why}`;
      else {
        gate = openGate();
        args = plan.args(gate);
        argv = plan.argv;
        obs = O.startObserver(oomObserver);
      }
    } catch (e) {
      ev.why = `not gated: ${e.message}`;
      if (gate) gate.cleanup();
      gate = null;
    }
  }
  const ungate = async (why) => {
    ev.why = why; ev.gate = 'not_used'; ev.observer = 'not_used';
    if (obs) { await obs.close(); obs = null; }
    if (gate) { gate.cleanup(); gate = null; }
  };
  const create = (a) => op(['create', '--name', name, ...(input !== undefined ? ['-i'] : []), ...a]);
  try {
    const t0 = Date.now();
    let created = await create(args);
    if (!created.ok && gate) {
      // the gate's mount or entrypoint may be what this daemon refused: run the caller's own arguments, ungated
      await ungate(`not gated: gated create failed (${created.stderr.trim().slice(0, 200) || 'timeout'})`);
      created = await create(createArgs);
    }
    if (!created.ok) {
      return { name, ...classifyStage(null, { infraError: `create failed: ${created.stderr.trim().slice(0, 300) || 'timeout'}` }),
        oom_evidence: evidenceSummary(ev, null),
        stdout: '', stderr: created.stderr, stdout_dropped: 0, stderr_dropped: 0, duration_ms: created.duration_ms };
    }
    const id = created.stdout.trim();
    ev.container = id;
    if (gate) {
      // the container must run exactly the gate, then the original command: anything else is not gated
      const c = await rawOp(['inspect', '-f', '{{json .Path}}{{"\\n"}}{{json .Args}}', id]);
      let ok = false;
      try {
        const [p, a] = c.ok ? c.stdout.trim().split('\n').map((x) => JSON.parse(x)) : [];
        ok = p === '/bin/sh' && JSON.stringify(a) === JSON.stringify([GATE_SCRIPT_PATH, ...argv]);
      } catch { ok = false; }
      if (!ok) {
        await rawOp(['rm', '-f', id]);
        await ungate('not gated: the created container does not run the gate with the original command');
        created = await create(createArgs);
        if (!created.ok) {
          return { name, ...classifyStage(null, { infraError: `create failed: ${created.stderr.trim().slice(0, 300) || 'timeout'}` }),
            oom_evidence: evidenceSummary(ev, null), stdout: '', stderr: created.stderr, stdout_dropped: 0, stderr_dropped: 0, duration_ms: created.duration_ms };
        }
        ev.container = created.stdout.trim();
      }
    }
    let ended = false;
    const startedP = runBounded(DOCKER, ['start', '-a', ...(input !== undefined ? ['-i'] : []), name],
      { input, timeoutMs: waitTimeoutMs, maxBytes }).then((r) => { ended = true; return r; });
    let gateFailure = null;
    if (gate) {
      ev.gate = 'waiting';
      const st = await waitRunning(name, () => ended);
      if (st) {
        const a = await obs.arm({ container: ev.container, pid: st.Pid, ...(oomObserver.cgroupRoot ? { cgroupRoot: oomObserver.cgroupRoot } : {}),
          ...(oomObserver.procRoot ? { procRoot: oomObserver.procRoot } : {}) });
        ev.observer = a && a.armed ? 'armed' : 'not_armed';
        if (!(a && a.armed)) ev.why = a ? `observer not armed: ${a.why}` : `observer lost before arming: ${obs.lost || 'no answer'}`;
        // observation never blocks the work: released whether or not the observer armed
        if (gate.release()) { ev.gate = 'released'; ev.gate_ms = Date.now() - t0; } else gateFailure = 'the start gate could not be released';
      } else gateFailure = ended ? 'the container ended before it reached the start gate' : 'the container did not start within the gate limit';
      if (gateFailure) { ev.gate = 'failed'; gate.abort(); await op(['kill', name]); }
    }
    const started = await startedP;
    if (obs) obs.exited();
    // Evidence is read only after Docker confirms the container exited (§8.4).
    let state = await inspectState(name);
    if (state && state.Running) {
      await op(['kill', name]);
      await op(['wait', name]);
      state = await inspectState(name);
    }
    state = await settleOom(name, state);
    let cgroup;
    if (obs) {
      const rec = await obs.finish();
      cgroup = rec || (obs.positive ? { ...obs.positive, unavailable: `observer lost after a positive read: ${obs.lost || 'no answer'}` }
        : { container: ev.container, unavailable: `observer lost: ${obs.lost || 'no answer'}` });
      if (!rec) ev.why = ev.why || cgroup.unavailable;
      if (ev.observer !== 'armed' && !cgroup.unavailable) cgroup = { ...cgroup, unavailable: ev.why || 'observer not armed' };
    } else cgroup = { container: ev.container, unavailable: ev.why || 'no observer' };
    // A stage the CLI stopped at its own wait deadline is a timeout (QB-22: its partial
    // edits are still captured afterwards). Otherwise the caller says why it stopped.
    const ctx = gateFailure ? { infraError: `start gate: ${gateFailure}` }
      : started.timedOut ? { killedBy: 'deadline' }
        : typeof killedBy === 'function' ? { killedBy: killedBy() } : { killedBy };
    return {
      name, ...classifyStage(state, { ...ctx, container: ev.container, cgroup }),
      oom_evidence: evidenceSummary(ev, cgroup),
      stdout: started.stdout, stderr: started.stderr,
      stdout_dropped: started.stdout_dropped, stderr_dropped: started.stderr_dropped,
      duration_ms: started.duration_ms,
    };
  } finally {
    if (obs) await obs.close();
    // the stopped container still names the gate directory as a bind source (docker cp mounts it again)
    if (gate) gate.cleanup({ keepFor: runLabelOf(createArgs) });
  }
}

/** The qb.run label in createArgs, or null. */
function runLabelOf(args) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i] === '--label' ? args[i + 1] : typeof args[i] === 'string' && args[i].startsWith('--label=') ? args[i].slice(8) : null;
    if (v && v.startsWith('qb.run=')) return v.slice(7);
  }
  return null;
}

/**
 * Remove a run's containers, then networks, then volumes. Returns what is left;
 * a count is null when Docker did not answer, never a guessed 0 (G5c).
 */
async function removeRun(runId) {
  const lbl = `label=qb.run=${runId}`;
  const ids = async (kind) => {
    const r = await op(kind === 'container' ? ['ps', '-aq', '--filter', lbl] : [kind, 'ls', '-q', '--filter', lbl]);
    return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
  };
  const c = await ids('container'); if (c && c.length) await op(['rm', '-f', ...c]);
  const n = await ids('network');   if (n && n.length) await op(['network', 'rm', ...n]);
  const v = await ids('volume');    if (v && v.length) await op(['volume', 'rm', '-f', ...v]);
  const count = async (kind) => { const x = await ids(kind); return x ? x.length : null; };
  const left = { containers: await count('container'), networks: await count('network'), volumes: await count('volume') };
  if (left.containers === 0) removeGateDirs(runId);   // KAN-96: only once no container can name them
  return left;
}

/** True when removeRun's report shows nothing left (and nothing unknown). */
const removed = (left) => Boolean(left) && left.containers === 0 && left.networks === 0 && left.volumes === 0;

module.exports = { DOCKER, contentTag, ensureImage, op, bindImages, inspectState, settleOom, available, listContainers, runContainers, runStage, removeRun, removed, runLabels,
  splitCreateArgs, GATE_REFUSED_EXIT };
