/**
 * KAN-96 experiment (senior 10813, option A): a host-side observer of ONE container's own memory cgroup, woken by
 * change notifications. Armed while the workload waits at a gate; no polling. Anything missed is unavailable.
 * Runs in a worker thread: { arm: { container, pid, root } } → 'armed' | 'unavailable'; { finish } → the record.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parentPort, isMainThread } = require('worker_threads');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const counter = (t, k) => { const m = new RegExp(`^${k} (\\d+)$`, 'm').exec(t); return m ? Number(m[1]) : NaN; };

/** @returns an observer: { record, armed, close() }. record is live and is never rewritten downwards. */
function observe({ container, pid, root = '/sys/fs/cgroup' }) {
  const t0 = now();
  const rec = { container, path: null, baseline: null, last: null, final: false, unavailable: null, notifications: { memory: 0, cgroup: 0 }, reads: 0, steps: [], arm_ms: null, reset: false };
  const watchers = [];
  const close = () => { for (const w of watchers.splice(0)) { try { w.close(); } catch { /* closed */ } } };
  const fail = (why) => { if (!rec.unavailable) rec.unavailable = why; close(); return { record: rec, armed: false, close }; };
  try {
    const line = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'));
    if (!line) return fail('no cgroup v2 line for the process');
    const dir = path.join(root, line.slice(3));
    if (!path.basename(dir).includes(container)) return fail('the process is not in a cgroup named after this container');
    if (!fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').split('\n').includes(String(pid))) return fail('the process is not listed in that cgroup');
    rec.path = line.slice(3);
    const read = (why) => {
      let populated = null; let m;
      // cgroup.events first: if it says empty, the memory.events read that follows covers the whole workload
      try { populated = counter(fs.readFileSync(path.join(dir, 'cgroup.events'), 'utf8'), 'populated'); } catch { /* gone */ }
      try { m = counter(fs.readFileSync(path.join(dir, 'memory.events'), 'utf8'), 'oom_kill'); } catch (e) { rec.steps.push([why, +(now() - t0).toFixed(3), `gone ${e.code}`]); if (!rec.final && !rec.unavailable) rec.unavailable = 'the cgroup disappeared before a final observation'; close(); return false; }
      rec.reads++;
      if (!Number.isSafeInteger(m)) { if (!rec.unavailable) rec.unavailable = 'memory.events has no oom_kill'; return false; }
      if (rec.last !== null && m < rec.last) { rec.reset = true; if (!rec.unavailable) rec.unavailable = 'the counter was reset'; return false; }
      rec.last = m;
      rec.steps.push([why, +(now() - t0).toFixed(3), m, populated]);
      if (populated === 0) { rec.final = true; close(); }
      return true;
    };
    for (const [file, key] of [['memory.events', 'memory'], ['cgroup.events', 'cgroup']]) {
      const w = fs.watch(path.join(dir, file), () => { rec.notifications[key]++; read(key); });
      w.on('error', (e) => { if (!rec.final && !rec.unavailable) rec.unavailable = `watch ${file}: ${e.code}`; });
      watchers.push(w);
    }
    // the baseline is read AFTER the watches exist, while the workload still waits
    if (!read('baseline')) return fail(rec.unavailable || 'no baseline');
    rec.baseline = rec.last;
    if (rec.baseline !== 0) return fail('no clean baseline');
    if (rec.final) return fail('the workload ended before it was admitted');
    rec.arm_ms = +(now() - t0).toFixed(3);
    return { record: rec, armed: true, close };
  } catch (e) { return fail(`${e.code || e.message}`); }
}
module.exports = { observe };

if (!isMainThread && parentPort) {
  const { performance } = require('perf_hooks');
  let cur = null; let elu = null;
  parentPort.on('message', (m) => {
    if (m.arm) { elu = performance.eventLoopUtilization(); cur = observe(m.arm); parentPort.postMessage({ armed: cur.armed, why: cur.record.unavailable }); }
    if (m.finish && cur) {
      cur.close();
      const u = performance.eventLoopUtilization(elu);
      const r = cur.record;
      if (r.baseline !== null && r.last === r.baseline && !r.final && !r.unavailable) r.unavailable = 'no final observation';
      parentPort.postMessage({ record: { ...r, observer_active_ms: +u.active.toFixed(3), observer_idle_ms: +u.idle.toFixed(3) } });
    }
  });
  parentPort.postMessage('ready');
}
