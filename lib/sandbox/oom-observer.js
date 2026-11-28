/**
 * lib/sandbox/oom-observer.js — KAN-96: supplementary, FALLIBLE OOM evidence from one container's own memory cgroup.
 *
 * A host-side observer, in its own worker thread, of exactly one container's `memory.events` (oom_kill) and
 * `cgroup.events` (populated). It is armed while the container waits at the trusted start gate (gate.js), so the
 * baseline is read before any task code runs. It is woken by the kernel's change notifications; it never polls.
 * After a memory.events notification it re-reads on a FIXED, bounded schedule (REREAD_DELAYS_MS, at most
 * MAX_REREADS per stage), because the kernel can defer a second notification for the same file while the container's
 * cgroup is removed a few milliseconds later (run 45509067778: 3 of 30 kills missed that way).
 *
 * What it can say (states.js cgroupEvidence decides):
 *   positive     baseline 0, then a larger oom_kill for this container: kept, even if the observer fails later;
 *   zero         only with a read taken after the cgroup said it was empty (populated 0);
 *   unavailable  anything else, with the reason. It is NEVER "no OOM": the observer misses kills.
 *
 * It needs the Docker host's cgroup v2 files (Linux, local daemon). On Docker Desktop (macOS) it is unavailable and
 * says so (hostSupport). Nothing here runs inside a container, and nothing a container writes is read as evidence.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

/** Frozen for KAN-96 batch 3: re-read delays (ms) after each memory.events notification, and the per-stage cap. */
const REREAD_DELAYS_MS = Object.freeze([1, 2, 3, 4, 6, 8, 10]);
const MAX_REREADS = 64;
const MAX_STEPS = 48;
const ARM_TIMEOUT_MS = 2000;
const FINISH_TIMEOUT_MS = 2000;
const CGROUP_ROOT = '/sys/fs/cgroup';
const PROC_ROOT = '/proc';

const counter = (t, k) => { const m = new RegExp(`^${k} (\\d+)$`, 'm').exec(t); return m ? Number(m[1]) : NaN; };

function defaultIo() {
  const t0 = process.hrtime.bigint();
  return {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    watch: (p, cb) => fs.watch(p, { persistent: false }, cb),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    now: () => Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

/**
 * Arm an observer of ONE container. Synchronous: the baseline is read before this returns.
 * @param {{ container: string, pid: number, cgroupRoot?: string, procRoot?: string, onPositive?: Function }} t
 * @param {object} [io] test seam: { readFile, watch, setTimeout, clearTimeout, now }
 * @returns {{ record: object, armed: boolean, read: (why: string) => void, close: () => void, timers: () => number }}
 */
function observe(t, io = defaultIo()) {
  const { container, pid, cgroupRoot = CGROUP_ROOT, procRoot = PROC_ROOT, onPositive } = t;
  const t0 = io.now();
  const rec = { container, path: null, baseline: null, last: null, final: false, unavailable: null, reset: false,
    notifications: { memory: 0, cgroup: 0 }, reads: 0, rereads: 0, rereads_capped: false, steps: [], arm_ms: null };
  const watchers = [];
  const timers = new Set();
  let closed = false;
  let chain = false;
  let told = false;
  const ms = () => +(io.now() - t0).toFixed(3);
  const step = (s) => { if (rec.steps.length < MAX_STEPS) rec.steps.push(s); };
  const close = () => {
    closed = true;
    for (const w of watchers.splice(0)) { try { w.close(); } catch { /* already closed */ } }
    for (const x of timers) io.clearTimeout(x);
    timers.clear();
  };
  const unavailable = (why) => { if (!rec.unavailable) rec.unavailable = why; };
  const positive = () => rec.baseline === 0 && Number.isSafeInteger(rec.last) && rec.last > 0;
  const handle = { record: rec, armed: false, close, timers: () => timers.size, read: (why) => { if (!closed) read(why); } };
  const fail = (why) => { unavailable(why); close(); return handle; };

  let dir;
  function read(why) {
    let populated = null;
    let m;
    // cgroup.events first: if it says empty, the memory.events read that follows covers the whole workload
    try { populated = counter(io.readFile(path.join(dir, 'cgroup.events')), 'populated'); } catch { /* gone: decided below */ }
    try { m = counter(io.readFile(path.join(dir, 'memory.events')), 'oom_kill'); } catch (e) {
      step([why, ms(), `gone ${e.code || 'error'}`]);
      if (!rec.final) unavailable('the cgroup disappeared before a final observation');
      close();
      return;
    }
    rec.reads++;
    if (!Number.isSafeInteger(m)) { unavailable('memory.events has no oom_kill'); close(); return; }
    if (rec.last !== null && m < rec.last) { rec.reset = true; unavailable('the counter was reset'); close(); return; }
    rec.last = m;
    step([why, ms(), m, Number.isNaN(populated) ? null : populated]);
    if (positive() && !told) { told = true; if (onPositive) { try { onPositive({ ...rec, steps: rec.steps.slice() }); } catch { /* the caller's problem */ } } }
    if (populated === 0 && rec.baseline !== null) { rec.final = true; close(); }
  }

  /** Fixed, bounded re-reads after a memory.events notification; never standing polling. */
  function rereads() {
    if (chain || closed || positive()) return;
    chain = true;
    let k = 0;
    let at = 0;
    const next = () => {
      if (closed || positive() || k >= REREAD_DELAYS_MS.length) { chain = false; return; }
      if (rec.rereads >= MAX_REREADS) { rec.rereads_capped = true; chain = false; return; }
      const d = REREAD_DELAYS_MS[k++] - at;
      at += d;
      const x = io.setTimeout(() => { timers.delete(x); if (closed) return; rec.rereads++; read('reread'); next(); }, d);
      timers.add(x);
    };
    next();
  }

  try {
    let line;
    try { line = io.readFile(path.join(procRoot, String(pid), 'cgroup')).split('\n').find((l) => l.startsWith('0::')); } catch (e) { return fail(`cannot read the process's cgroup (${e.code || e.message})`); }
    if (!line) return fail('no cgroup v2 line for the process');
    dir = path.join(cgroupRoot, line.slice(3));
    if (!container || !path.basename(dir).includes(container)) return fail('the process is not in a cgroup named after this container');
    let procs;
    try { procs = io.readFile(path.join(dir, 'cgroup.procs')).split('\n'); } catch (e) { return fail(`cannot read cgroup.procs (${e.code || e.message})`); }
    if (!procs.includes(String(pid))) return fail('the process is not listed in that cgroup');
    rec.path = line.slice(3);
    for (const [file, key] of [['memory.events', 'memory'], ['cgroup.events', 'cgroup']]) {
      let w;
      try {
        w = io.watch(path.join(dir, file), () => {
          if (closed) return;
          rec.notifications[key]++;
          read(key);
          if (key === 'memory') rereads();
        });
      } catch (e) { return fail(`cannot watch ${file} (${e.code || e.message})`); }
      if (w && typeof w.on === 'function') w.on('error', (e) => { if (!rec.final) unavailable(`watch ${file}: ${e.code || e.message}`); close(); });
      watchers.push(w);
    }
    // the baseline is read AFTER the watches exist, while the workload still waits at the gate
    read('baseline');
    if (closed && rec.last === null) return fail(rec.unavailable || 'no baseline');
    rec.baseline = rec.last;
    if (rec.baseline !== 0) return fail('no clean baseline (a kill was already counted)');
    rec.arm_ms = ms();
    handle.armed = true;
    return handle;
  } catch (e) { return fail(`observer error: ${e.code || e.message}`); }
}

/** The record as evidence: a missing final observation is unavailable, never zero. */
function finalRecord(rec) {
  const r = { ...rec, steps: rec.steps.slice() };
  if (!r.final && !r.unavailable && !(r.baseline === 0 && r.last > 0)) r.unavailable = r.baseline === null ? 'not armed' : 'no final observation';
  return r;
}

/**
 * Whether this host can observe container cgroups at all. `o` is the runStage `oomObserver` option
 * (tests and the KAN-96 diagnostic only; product callers pass nothing).
 */
function hostSupport(o = {}, env = process.env, platform = process.platform) {
  if (o.enabled === false || env.QB_OOM_OBSERVER === 'off') return { ok: false, why: 'the OOM observer is turned off' };
  if (o.force) return { ok: true };
  if (platform !== 'linux') return { ok: false, why: `observer unavailable on this host (${platform}): it needs the Docker host's own cgroup v2 files, and Docker Desktop runs containers in a VM` };
  const root = o.cgroupRoot || CGROUP_ROOT;
  if (!o.cgroupRoot && !fs.existsSync(path.join(root, 'cgroup.controllers'))) return { ok: false, why: 'observer unavailable on this host: no cgroup v2 at /sys/fs/cgroup' };
  const dh = env.DOCKER_HOST;
  if (dh && !dh.startsWith('unix://')) return { ok: false, why: 'observer unavailable: the Docker daemon is not local (DOCKER_HOST)' };
  return { ok: true };
}

const LIVE = new Set();
/** Observer threads still running in this process (cleanup checks). */
const liveObservers = () => LIVE.size;

/**
 * Start one observer thread for one stage. Every method resolves; a lost thread gives null, never an exception.
 * @returns {{ ready: Promise<boolean>, arm, exited, finish, close, positive: object|null, lost: string|null }}
 */
function startObserver(o = {}) {
  const armTimeoutMs = o.armTimeoutMs || ARM_TIMEOUT_MS;
  const finishTimeoutMs = o.finishTimeoutMs || FINISH_TIMEOUT_MS;
  const h = { positive: null, lost: null, closed: false };
  const pending = new Map();
  const settle = (type, v) => { const p = pending.get(type); if (p) { pending.delete(type); p(v); } };
  const loseAll = (why) => { if (!h.lost && !h.closed) h.lost = why; for (const k of [...pending.keys()]) settle(k, null); };
  let w;
  try {
    w = new Worker(o.workerFile || __filename, { workerData: { qbOomObserver: true } });
  } catch (e) {
    h.lost = `observer thread did not start: ${e.message}`;
    return Object.assign(h, { ready: Promise.resolve(false), arm: async () => null, exited() {}, finish: async () => null, close: async () => {} });
  }
  LIVE.add(w);
  w.unref();
  w.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'positive' && m.record) h.positive = m.record;
    settle(m.type, m);
  });
  w.on('error', (e) => loseAll(`observer thread failed: ${e.message}`));
  w.on('exit', (code) => { LIVE.delete(w); loseAll(`observer thread exited (${code})`); });
  const ask = (type, msg, ms) => new Promise((resolve) => {
    if (h.lost || h.closed) { resolve(null); return; }
    const timer = setTimeout(() => { if (pending.get(type)) { h.lost = h.lost || `observer did not answer ${type} within ${ms} ms`; settle(type, null); } }, ms);
    pending.set(type, (v) => { clearTimeout(timer); resolve(v); });
    try { w.postMessage(msg); } catch (e) { h.lost = h.lost || `observer: ${e.message}`; settle(type, null); }
  });
  h.ready = ask('ready', { hello: true }, armTimeoutMs).then(Boolean);
  h.arm = async (target) => { await h.ready; return ask('armed', { arm: target }, armTimeoutMs); };
  h.exited = () => { if (!h.lost && !h.closed) { try { w.postMessage({ lifecycle: 'exit' }); } catch { /* lost */ } } };
  h.finish = async () => { const m = await ask('record', { finish: true }, finishTimeoutMs); return m ? m.record : null; };
  h.close = async () => { h.closed = true; for (const k of [...pending.keys()]) settle(k, null); try { await w.terminate(); } catch { /* gone */ } LIVE.delete(w); };
  return h;
}

if (!isMainThread && parentPort && workerData && workerData.qbOomObserver) {
  const { performance } = require('perf_hooks');
  let cur = null;
  let elu = null;
  parentPort.on('message', (m) => {
    if (m.hello) parentPort.postMessage({ type: 'ready' });
    if (m.arm) {
      elu = performance.eventLoopUtilization();
      cur = observe({ ...m.arm, onPositive: (record) => parentPort.postMessage({ type: 'positive', record }) });
      parentPort.postMessage({ type: 'armed', armed: cur.armed, why: cur.record.unavailable, arm_ms: cur.record.arm_ms });
    }
    if (m.lifecycle === 'exit' && cur) cur.read('exit');
    if (m.finish) {
      if (cur) { cur.read('finish'); cur.close(); }
      const u = elu ? performance.eventLoopUtilization(elu) : null;
      const record = cur ? finalRecord(cur.record) : { unavailable: 'not armed' };
      parentPort.postMessage({ type: 'record', record: { ...record, observer_active_ms: u ? +u.active.toFixed(3) : null } });
    }
  });
}

module.exports = { observe, finalRecord, hostSupport, startObserver, liveObservers, REREAD_DELAYS_MS, MAX_REREADS, ARM_TIMEOUT_MS, FINISH_TIMEOUT_MS };
