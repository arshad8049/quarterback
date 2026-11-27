/**
 * KAN-106 10838 fix (1): the residency-aware resource gate and the read-only host snapshot. Fixtures only:
 * no model, no Ollama, no real host probe (every exec/readFile/fetch is injected).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gate, GiB } = require('../../bench/kan106-eval-v2/resource-gate');
const hs = require('../../bench/kan106-eval-v2/host-snapshot');
const PLAN = require('../../bench/kan106-eval-v2/plan.json');

const POLICY = PLAN.normative.resource_gate;
const MODEL = { name: PLAN.normative.model.name, digest: PLAN.normative.model.digest };
const T = '2026-12-01T10:00:00.000Z';
const inMin = (m) => new Date(Date.parse(T) + m * 60_000).toISOString();
const resident = (o = {}) => ({ name: MODEL.name, digest: MODEL.digest, size: Math.round(10.6 * GiB), size_vram: Math.round(10.6 * GiB), expires_at: inMin(4), context_length: 8192, ...o });
const mac = ({ avail, level = 1, swap = 0, loaded = [] } = {}) => ({ taken_utc: T, os: { platform: 'darwin', arch: 'arm64' },
  memory: { total_bytes: 18 * GiB, available_bytes: avail, swap_used_bytes: swap, pressure: { kind: 'darwin_level', level } }, ollama: { loaded } });
const linux = ({ avail, psi = 0, swap = 0, loaded = [] } = {}) => ({ taken_utc: T, os: { platform: 'linux', arch: 'x64' },
  memory: { total_bytes: 16 * GiB, available_bytes: avail, swap_used_bytes: swap, pressure: { kind: 'linux_psi', full_avg10: psi } }, ollama: { loaded } });
const g = (snapshot, previous = null) => gate({ snapshot, previous, policy: POLICY, model: MODEL });

test('frozen thresholds are explicit numbers (not derived from disk size)', () => {
  assert.equal(POLICY.reserve_bytes, 2 * GiB);
  assert.equal(POLICY.cold_runtime_bytes, 11 * GiB);
  assert.ok(POLICY.cold_runtime_bytes > 8988124298, 'the runtime estimate exceeds the Q4_K_M file size (disk size is not runtime memory)');
  assert.equal(POLICY.num_ctx, 8192);
  assert.equal(POLICY.warm_min_remaining_s, 120);
  assert.equal(POLICY.swap_growth_max_bytes, 256 * 1024 * 1024);
});

test('WARM 18 GB Mac: the resident pinned model is not charged twice; the old "size + 2 GiB" rule would have blocked it', () => {
  const s = mac({ avail: 3.1 * GiB, loaded: [resident()] });
  const r = g(s);
  assert.equal(r.rule, 'warm');
  assert.equal(r.required_bytes, 2 * GiB);
  assert.equal(r.admit, true, r.reasons.join('; '));
  const oldRule = s.memory.available_bytes >= s.ollama.loaded[0].size + 2 * GiB;
  assert.equal(oldRule, false, 'plan v2 rule double-counted the resident model');
});

test('COLD Mac: needs the frozen runtime estimate + reserve; 14 GiB admits, 12 GiB blocks', () => {
  const ok = g(mac({ avail: 14 * GiB }));
  assert.equal(ok.rule, 'cold'); assert.equal(ok.required_bytes, 13 * GiB); assert.equal(ok.admit, true, ok.reasons.join('; '));
  const no = g(mac({ avail: 12 * GiB }));
  assert.equal(no.admit, false); assert.match(no.reasons.join(), /insufficient_memory: available 12\.00 GiB < required 13\.00 GiB \(cold\)/);
});

test('unknown capacity is unavailable, never sufficient', () => {
  assert.match(g(mac({ avail: null, loaded: [resident()] })).reasons.join(), /capacity_unknown/);
  assert.equal(g(null).admit, false);
  assert.equal(g({ taken_utc: T, os: { platform: 'darwin' } }).admit, false);
  const noPs = mac({ avail: 20 * GiB }); noPs.ollama = { loaded: null };
  assert.match(g(noPs).reasons.join(), /residency_unknown/);
  const noPressure = mac({ avail: 20 * GiB }); noPressure.memory.pressure = { kind: 'darwin_level', level: null };
  assert.match(g(noPressure).reasons.join(), /pressure_unknown/);
  const noSwap = mac({ avail: 20 * GiB }); noSwap.memory.swap_used_bytes = null;
  assert.match(g(noSwap).reasons.join(), /swap_unknown/);
  assert.match(g({ ...mac({ avail: 20 * GiB }), os: { platform: 'win32' } }).reasons.join(), /unsupported platform/);
});

test('another model resident blocks, including the pinned name with another digest', () => {
  assert.match(g(mac({ avail: 20 * GiB, loaded: [resident({ name: 'deepseek-r1:7b', digest: 'a'.repeat(64) })] })).reasons.join(), /other_model_loaded: deepseek-r1:7b/);
  const r = g(mac({ avail: 20 * GiB, loaded: [resident({ digest: 'b'.repeat(64) })] }));
  assert.equal(r.admit, false); assert.equal(r.rule, 'cold');
});

test('a resident model that is about to expire, or was loaded with another context length, is held to the cold rule', () => {
  const soon = g(mac({ avail: 3.1 * GiB, loaded: [resident({ expires_at: inMin(1) })] }));
  assert.equal(soon.rule, 'cold'); assert.equal(soon.admit, false); assert.match(soon.resident.held_to_cold_rule, /expires too soon/);
  const ctx = g(mac({ avail: 3.1 * GiB, loaded: [resident({ context_length: 4096 })] }));
  assert.equal(ctx.rule, 'cold'); assert.match(ctx.resident.held_to_cold_rule, /context length/);
  const noCtx = g(mac({ avail: 3.1 * GiB, loaded: [resident({ context_length: null })] }));
  assert.equal(noCtx.rule, 'warm', 'an unreported context length does not by itself force a reload estimate');
});

test('pressure: cold needs normal; warm blocks only above warn (macOS); PSI bounds on Linux', () => {
  assert.match(g(mac({ avail: 20 * GiB, level: 2 })).reasons.join(), /memory_pressure: level 2 > 1 \(cold\)/);
  assert.equal(g(mac({ avail: 3.1 * GiB, level: 2, loaded: [resident()] })).admit, true);
  assert.match(g(mac({ avail: 3.1 * GiB, level: 4, loaded: [resident()] })).reasons.join(), /level 4 > 2 \(warm\)/);
  assert.equal(g(linux({ avail: 14 * GiB, psi: 0.5 })).admit, true);
  assert.match(g(linux({ avail: 14 * GiB, psi: 2 })).reasons.join(), /PSI full avg10 2 > 1 \(cold\)/);
  assert.equal(g(linux({ avail: 3 * GiB, psi: 5, loaded: [resident()] })).admit, true);
  assert.match(g(linux({ avail: 3 * GiB, psi: 11, loaded: [resident()] })).reasons.join(), /> 10 \(warm\)/);
  const noPsi = linux({ avail: 14 * GiB }); noPsi.memory.pressure.full_avg10 = null;
  assert.match(g(noPsi).reasons.join(), /pressure_unknown/);
});

test('Linux cold/warm on a 16 GB host use MemAvailable the same way', () => {
  assert.equal(g(linux({ avail: 13.5 * GiB })).admit, true);
  assert.equal(g(linux({ avail: 12.9 * GiB })).admit, false);
  assert.equal(g(linux({ avail: 2.5 * GiB, loaded: [resident()] })).admit, true);
  assert.equal(g(linux({ avail: 1.9 * GiB, loaded: [resident()] })).admit, false);
});

test('swap growth since the previous item above the frozen bound blocks; growth is recorded', () => {
  const prev = mac({ avail: 3 * GiB, swap: 1 * GiB, loaded: [resident()] });
  const ok = g(mac({ avail: 3 * GiB, swap: 1 * GiB + 100 * 1024 * 1024, loaded: [resident()] }), prev);
  assert.equal(ok.admit, true); assert.equal(ok.swap_growth_bytes, 100 * 1024 * 1024);
  assert.match(g(mac({ avail: 3 * GiB, swap: 1.5 * GiB, loaded: [resident()] }), prev).reasons.join(), /swap_growth/);
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12000.
Pages active:                            300000.
Pages inactive:                          188000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        400000.
Pages purgeable:                           3000.
File-backed pages:                       150000.
Anonymous pages:                         340000.
Pages occupied by compressor:             60000.
`;
test('macOS parsers: available = (free + inactive) x page size; swap from vm.swapusage', () => {
  const vm = hs.parseVmStat(VM_STAT);
  assert.equal(vm.page_size, 16384);
  assert.equal(hs.darwinAvailable(vm), (12000 + 188000) * 16384);
  assert.equal(hs.darwinAvailable({ ...vm, inactive: null }), null);
  assert.deepEqual(hs.parseSwapUsage('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'), { total_bytes: 2048 * 1024 ** 2, used_bytes: Math.round(1024.5 * 1024 ** 2) });
  assert.equal(hs.parseSwapUsage('garbage'), null);
});

test('Linux parsers: MemAvailable, swap and PSI full avg10', () => {
  const mi = hs.parseMeminfo('MemTotal:       16303412 kB\nMemFree:  1000 kB\nMemAvailable:   14100000 kB\nSwapTotal:  4194300 kB\nSwapFree:  4194300 kB\n');
  assert.equal(mi.available_bytes, 14100000 * 1024);
  const psi = hs.parsePsi('some avg10=0.31 avg60=0.10 avg300=0.02 total=1\nfull avg10=0.12 avg60=0.00 avg300=0.00 total=1\n');
  assert.equal(psi.full.avg10, 0.12);
  assert.equal(hs.parsePsi(''), null);
});

test('snapshot(): fixture probes only; no hostname, no user, basenames only; a failing probe is null, not a guess', async () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'vm_stat') return { status: 0, stdout: VM_STAT };
    if (cmd === 'sysctl' && args[1] === 'hw.memsize') return { status: 0, stdout: String(18 * GiB) };
    if (cmd === 'sysctl' && args[1] === 'vm.swapusage') return { status: 0, stdout: 'total = 0.00M  used = 0.00M  free = 0.00M' };
    if (cmd === 'sysctl' && args[1] === 'kern.memorystatus_vm_pressure_level') return { status: 0, stdout: '1\n' };
    if (cmd === 'ps') return { status: 0, stdout: ' 900000 /Applications/Some.app/Contents/MacOS/Some\n 100 /usr/sbin/x\n' };
    return { status: 1, stdout: '' };   // docker not running
  };
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return u.endsWith('/api/ps') ? { models: [resident()] } : { version: '9.9.9' }; };
  const s = await hs.snapshot({ exec, fetchJson, platform: 'darwin', arch: 'arm64', now: () => new Date(T), cpus: [{ model: 'Fake CPU' }], release: '1' });
  assert.equal(s.memory.available_bytes, 200000 * 16384);
  assert.equal(s.memory.pressure.level, 1);
  assert.equal(s.memory.swap_used_bytes, 0);
  assert.equal(s.docker.running, false);
  assert.equal(s.top_rss[0].command, 'Some');
  assert.equal(s.ollama.loaded[0].digest, MODEL.digest);
  assert.deepEqual(urls.map((u) => new URL(u).pathname).sort(), ['/api/ps', '/api/version'], 'listing endpoints only: never /api/chat or /api/generate');
  assert.ok(!calls.some((c) => /hostname|whoami|scutil/.test(c)));
  assert.doesNotMatch(JSON.stringify(s), /\/Applications|\/Users\//);
  const broken = await hs.snapshot({ exec: () => { throw new Error('no'); }, fetchJson: async () => null, platform: 'darwin', now: () => new Date(T), cpus: [] });
  assert.equal(broken.memory.available_bytes, null);
  assert.equal(broken.ollama.loaded, null);
  assert.equal(gate({ snapshot: broken, policy: POLICY, model: MODEL }).admit, false);
});
