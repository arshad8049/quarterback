#!/usr/bin/env node
/**
 * KAN-106 10838: a READ-ONLY host snapshot for the evaluation v2 batch. No model call, no inference, no
 * model load or unload: it reads OS counters and the Ollama listing endpoints only (/api/version, /api/ps,
 * /api/tags; never /api/generate or /api/chat).
 *
 *   node bench/kan106-eval-v2/host-snapshot.js [--no-ollama] [--ollama-url URL]
 *
 * Every probe is injectable (exec, readFile, fetchJson, platform, now) so tests run on fixtures only.
 * A probe that fails or returns something unparseable yields null for that field, never a guess:
 * the resource gate treats unknown capacity as UNAVAILABLE (resource-gate.js).
 *
 * Available memory, frozen definitions (plan.json normative resource_gate.*):
 *   darwin: (vm_stat "Pages free" + "Pages inactive") x page size. This is psutil's macOS `available`
 *           (vm_stat "Pages free" already excludes speculative pages). Wired, active and compressed memory
 *           are not counted, so a RESIDENT model (wired/active) is already outside `available`.
 *   linux:  /proc/meminfo MemAvailable (the kernel's own estimate of memory available without swapping).
 * Pressure: darwin sysctl kern.memorystatus_vm_pressure_level (1 normal, 2 warn, 4 critical);
 *           linux /proc/pressure/memory "full avg10".
 * Swap:     darwin sysctl vm.swapusage "used"; linux SwapTotal - SwapFree.
 * No hostname, user name or path is recorded (public evidence); process names are basenames only.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const UNITS = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

function parseVmStat(text) {
  if (typeof text !== 'string') return null;
  const ps = text.match(/page size of (\d+) bytes/);
  const page = (label) => { const m = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  const out = { page_size: ps ? Number(ps[1]) : null, free: page('Pages free'), inactive: page('Pages inactive'), active: page('Pages active'),
    speculative: page('Pages speculative'), wired: page('Pages wired down'), purgeable: page('Pages purgeable'),
    compressor: page('Pages occupied by compressor'), file_backed: page('File-backed pages'), anonymous: page('Anonymous pages') };
  return out;
}
/** darwin available bytes per the frozen definition, or null when any input is unknown. */
function darwinAvailable(vm) {
  if (!vm || !Number.isInteger(vm.page_size) || !Number.isInteger(vm.free) || !Number.isInteger(vm.inactive)) return null;
  return (vm.free + vm.inactive) * vm.page_size;
}
/** `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)` -> bytes. */
function parseSwapUsage(text) {
  if (typeof text !== 'string') return null;
  const get = (k) => { const m = text.match(new RegExp(`${k} = ([\\d.]+)([BKMGT])`)); return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : null; };
  const total = get('total'); const used = get('used');
  return total === null || used === null ? null : { total_bytes: total, used_bytes: used };
}
function parseMeminfo(text) {
  if (typeof text !== 'string') return null;
  const kb = (k) => { const m = text.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')); return m ? Number(m[1]) * 1024 : null; };
  return { total_bytes: kb('MemTotal'), available_bytes: kb('MemAvailable'), swap_total_bytes: kb('SwapTotal'), swap_free_bytes: kb('SwapFree') };
}
function parsePsi(text) {
  if (typeof text !== 'string') return null;
  const line = (k) => { const m = text.match(new RegExp(`^${k} avg10=([\\d.]+) avg60=([\\d.]+) avg300=([\\d.]+)`, 'm')); return m ? { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]) } : null; };
  const some = line('some'); const full = line('full');
  return some || full ? { some, full } : null;
}
const intOrNull = (s) => { const n = Number(String(s == null ? '' : s).trim()); return Number.isInteger(n) ? n : null; };
/** `ps -axo rss=,comm=` -> top N by RSS, basenames only. */
function parsePs(text, n = 10) {
  if (typeof text !== 'string') return null;
  return text.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean)
    .map((m) => ({ rss_bytes: Number(m[1]) * 1024, command: path.basename(m[2].trim()) }))
    .sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, n);
}
function psModels(ps) {
  if (!ps || !Array.isArray(ps.models)) return null;
  return ps.models.map((m) => ({ name: m.name || m.model || null, digest: m.digest || null, size: Number.isFinite(m.size) ? m.size : null,
    size_vram: Number.isFinite(m.size_vram) ? m.size_vram : null, expires_at: m.expires_at || null,
    context_length: Number.isInteger(m.context_length) ? m.context_length : null }));
}

function defaultExec(cmd, args) {
  const r = require('../../lib/proc').run(cmd, args, { timeout: 10_000 });
  return { status: r.status, stdout: r.stdout || '', error: r.error ? String(r.error.message) : null };
}
async function defaultFetchJson(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
const defaultReadFile = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/**
 * @returns {Promise<object>} qb-kan106-host-snapshot/1
 */
async function snapshot({ exec = defaultExec, readFile = defaultReadFile, fetchJson = defaultFetchJson, platform = process.platform,
  arch = process.arch, now = () => new Date(), ollamaUrl = 'http://127.0.0.1:11434', ollama = true, cpus = os.cpus(), totalmem = os.totalmem(),
  release = os.release() } = {}) {
  const run = (cmd, args) => { try { const r = exec(cmd, args); return r && r.status === 0 ? r.stdout : null; } catch { return null; } };
  const snap = { schema: 'qb-kan106-host-snapshot/1', taken_utc: now().toISOString(), os: { platform, arch, release },
    cpu: { model: cpus && cpus[0] ? cpus[0].model : null, count: cpus ? cpus.length : null }, memory: null, ollama: null, docker: null, top_rss: null };
  if (platform === 'darwin') {
    const vm = parseVmStat(run('vm_stat', []));
    const swap = parseSwapUsage(run('sysctl', ['-n', 'vm.swapusage']));
    snap.memory = { total_bytes: intOrNull(run('sysctl', ['-n', 'hw.memsize'])) ?? (Number.isInteger(totalmem) ? totalmem : null),
      available_bytes: darwinAvailable(vm), available_basis: 'darwin: (vm_stat Pages free + Pages inactive) x page size (psutil available)',
      swap_used_bytes: swap ? swap.used_bytes : null, swap_total_bytes: swap ? swap.total_bytes : null,
      pressure: { kind: 'darwin_level', level: intOrNull(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])) }, vm_stat: vm };
  } else if (platform === 'linux') {
    const mi = parseMeminfo(readFile('/proc/meminfo'));
    const psi = parsePsi(readFile('/proc/pressure/memory'));
    snap.memory = { total_bytes: mi ? mi.total_bytes : null, available_bytes: mi ? mi.available_bytes : null, available_basis: 'linux: /proc/meminfo MemAvailable',
      swap_used_bytes: mi && Number.isInteger(mi.swap_total_bytes) && Number.isInteger(mi.swap_free_bytes) ? mi.swap_total_bytes - mi.swap_free_bytes : null,
      swap_total_bytes: mi ? mi.swap_total_bytes : null,
      pressure: { kind: 'linux_psi', full_avg10: psi && psi.full ? psi.full.avg10 : null, some_avg10: psi && psi.some ? psi.some.avg10 : null } };
  } else {
    snap.memory = { total_bytes: null, available_bytes: null, available_basis: `unsupported platform ${platform}`, swap_used_bytes: null, swap_total_bytes: null, pressure: { kind: 'unknown' } };
  }
  snap.top_rss = parsePs(run('ps', ['-axo', 'rss=,comm=']));
  const dockerOut = run('docker', ['info', '--format', '{{json .}}']);
  if (dockerOut) {
    try { const d = JSON.parse(dockerOut); snap.docker = { running: true, mem_total_bytes: d.MemTotal ?? null, ncpu: d.NCPU ?? null, containers_running: d.ContainersRunning ?? null }; } catch { snap.docker = { running: null, error: 'unparseable docker info' }; }
  } else snap.docker = { running: false };
  if (ollama) {
    const [version, ps] = await Promise.all([fetchJson(`${ollamaUrl}/api/version`), fetchJson(`${ollamaUrl}/api/ps`)]);
    snap.ollama = { url_host: (() => { try { return new URL(ollamaUrl).host; } catch { return null; } })(), version: version && version.version ? version.version : null, loaded: psModels(ps) };
  }
  return snap;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--ollama-url');
  snapshot({ ollama: !a.includes('--no-ollama'), ...(i >= 0 ? { ollamaUrl: a[i + 1] } : {}) })
    .then((s) => process.stdout.write(JSON.stringify(s, null, 2) + '\n'), (e) => { console.error(`✗ host-snapshot: ${e.message}`); process.exit(1); });
}
module.exports = { snapshot, parseVmStat, darwinAvailable, parseSwapUsage, parseMeminfo, parsePsi, parsePs, psModels };
