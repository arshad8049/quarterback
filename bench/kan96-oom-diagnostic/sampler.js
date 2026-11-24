/**
 * KAN-96 diagnostic (senior 10807): samples ONE container's own memory cgroup from the host while it lives.
 *
 * The path is never assumed: it is resolved from /proc/<pid>/cgroup of a process whose cgroup names this exact
 * container id, then validated (the directory name holds the full id; the pid is listed in its cgroup.procs). The
 * parent cgroup is never read for evidence. Every read is time-stamped; what could not be read is reported as
 * unavailable, never as zero. The container is only observed: nothing runs in it and nothing is written.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);
const ms = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const read = (p) => { try { return { text: fs.readFileSync(p, 'utf8') }; } catch (e) { return { error: e.code || String(e) }; } };
const counters = (text) => Object.fromEntries(text.trim().split('\n').map((l) => l.split(/\s+/)).filter((x) => x.length === 2).map(([k, v]) => [k, Number(v)]));

/** The cgroup v2 directory of container `id`, from its own processes; null until one exists. */
function resolve(id, root) {
  let pids;
  try { pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).map(Number).sort((a, b) => b - a); } catch (e) { return { error: `proc: ${e.code}` }; }
  for (const pid of pids) {
    const r = read(`/proc/${pid}/cgroup`);
    if (!r.text || !r.text.includes(id)) continue;
    const line = r.text.split('\n').find((l) => l.startsWith('0::'));
    if (!line) return { error: `pid ${pid}: no cgroup v2 line` };
    const rel = line.slice(3);
    const dir = path.join(root, rel);
    const procs = read(path.join(dir, 'cgroup.procs'));
    return { pid, rel, dir, name_has_full_id: path.basename(rel).includes(id), pid_listed: procs.text ? procs.text.split('\n').includes(String(pid)) : null, procs_error: procs.error || null };
  }
  return null;
}

/** Blocking; bounded by limitMs. Returns every CHANGED reading plus the first and the last good one. */
function sample(id, { root = '/sys/fs/cgroup', limitMs = 20_000, everyMs = 0.5, stop = null } = {}) {
  const t0 = ms();
  const out = { container: id, resolved: null, resolve_attempts: 0, files: {}, reads: 0, readings: [], first: null, last: null, ended: null, oom_group: null, memory_max: null };
  const over = () => ms() - t0 > limitMs || (stop && Atomics.load(stop, 0) === 1);
  let where = null;
  while (!where && !over()) { out.resolve_attempts++; where = resolve(id, root); if (!where) sleep(everyMs); }
  if (!where) { out.ended = 'unavailable: the container cgroup was never seen'; return out; }
  if (where.error) { out.ended = `unavailable: ${where.error}`; return out; }
  // the process found first can be a short-lived runtime helper: look again (bounded) for one its cgroup.procs lists
  for (let k = 0; k < 5 && !where.pid_listed && !over(); k++) { sleep(everyMs); const again = resolve(id, root); if (again && !again.error && again.rel === where.rel) where = again; }
  out.resolved = { ...where, at_ms: ms() - t0 };
  if (!where.name_has_full_id) { out.ended = 'unavailable: the resolved cgroup does not carry the full container id'; return out; }
  out.oom_group = read(path.join(where.dir, 'memory.oom.group')).text?.trim() ?? null;
  out.memory_max = read(path.join(where.dir, 'memory.max')).text?.trim() ?? null;
  let prev = '';
  while (!over()) {
    const ev = read(path.join(where.dir, 'memory.events'));
    const local = read(path.join(where.dir, 'memory.events.local'));
    if (!ev.text) { out.ended = `cgroup gone (${ev.error}) after ${out.reads} reads`; break; }
    out.reads++;
    const row = { at_ms: ms() - t0, events: counters(ev.text), local: local.text ? counters(local.text) : { error: local.error } };
    if (!out.first) out.first = row;
    out.last = row;
    if (ev.text !== prev) { out.readings.push(row); prev = ev.text; }
    sleep(everyMs);
  }
  if (!out.ended) out.ended = 'sampling limit reached or stopped while the cgroup was still there';
  return out;
}

/** What the samples support for THIS container; never zero for something not read. */
function conclude(s) {
  if (!s || !s.last) return { oom_kill: 'unknown', why: (s && s.ended) || 'no sample' };
  const a = s.first.events.oom_kill; const b = s.last.events.oom_kill;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { oom_kill: 'unknown', why: 'memory.events has no oom_kill field' };
  return { oom_kill: b, baseline: a, delta: b - a, baseline_before_workload: a === 0, why: a === 0 ? 'baseline 0 read while alive' : 'first read already counted a kill: no pre-workload baseline' };
}

module.exports = { sample, resolve, conclude };
if (require.main === module) console.log(JSON.stringify(sample(process.argv[2], { limitMs: Number(process.argv[3] || 20_000) })));
