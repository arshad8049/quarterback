/**
 * KAN-106 10838 fix (1): a RESIDENCY-AWARE resource gate, decided before every item from a read-only host
 * snapshot (host-snapshot.js). Pure function: no I/O, no model call.
 *
 * The plan v2 rule ("free memory >= model size + 2 GiB after every item") double-counted a resident model:
 * once the pinned model is loaded, its memory is already outside `available`, so demanding its size again
 * would wrongly block a warm 18 GB Mac. This gate instead charges only the INCREMENTAL load:
 *
 *   warm  (the pinned model, by name AND full digest, is resident, has not nearly expired, and was not loaded
 *          with a different context length): required = reserve_bytes
 *   cold  (anything else):                         required = cold_runtime_bytes + reserve_bytes
 *
 * cold_runtime_bytes is a FROZEN runtime estimate (weights + KV cache at num_ctx + compute buffers). The model's
 * disk size from /api/tags is not runtime memory and is never used as the requirement.
 *
 * Blocks (resource_blocked, the item is not launched) on any of:
 *   - capacity unknown (available, pressure or swap not readable): unknown is unavailable, never sufficient;
 *   - the Ollama listing (/api/ps) unknown;
 *   - any other model resident (another name, or the pinned name with another digest);
 *   - available < required;
 *   - pressure above the frozen cold/warm bound;
 *   - swap growth since the previous item's gate snapshot above swap_growth_max_bytes.
 */
'use strict';

const GiB = 1024 ** 3;

function gate({ snapshot, previous = null, policy, model, now = null }) {
  const reasons = [];
  const out = { schema: 'qb-kan106-resource-gate/1', admit: false, rule: null, reasons, required_bytes: null, available_bytes: null,
    pressure: null, swap_used_bytes: null, swap_growth_bytes: null, resident: null };
  if (!snapshot || !snapshot.memory) { reasons.push('capacity_unknown: no host memory snapshot'); return out; }
  const mem = snapshot.memory;
  const platform = snapshot.os && snapshot.os.platform;
  out.available_bytes = Number.isFinite(mem.available_bytes) ? mem.available_bytes : null;
  out.swap_used_bytes = Number.isFinite(mem.swap_used_bytes) ? mem.swap_used_bytes : null;
  out.pressure = mem.pressure || null;

  // residency (incremental load)
  const loaded = snapshot.ollama ? snapshot.ollama.loaded : null;
  let warm = false;
  if (!Array.isArray(loaded)) reasons.push('residency_unknown: the Ollama /api/ps listing is unavailable');
  else {
    const pinned = loaded.filter((m) => m.name === model.name && m.digest === model.digest);
    const others = loaded.filter((m) => !(m.name === model.name && m.digest === model.digest));
    if (others.length) reasons.push(`other_model_loaded: ${others.map((m) => `${m.name}@${String(m.digest).slice(0, 12)}`).join(', ')}`);
    if (pinned.length) {
      const m = pinned[0];
      const t = Date.parse(m.expires_at);
      const at = now ? Date.parse(now) : Date.parse(snapshot.taken_utc);
      const remaining = Number.isFinite(t) && Number.isFinite(at) ? (t - at) / 1000 : null;
      const ctxOk = m.context_length === null || m.context_length === undefined || m.context_length === policy.num_ctx;
      warm = remaining !== null && remaining >= policy.warm_min_remaining_s && ctxOk;
      out.resident = { size: m.size, size_vram: m.size_vram, expires_in_s: remaining, context_length: m.context_length ?? null,
        held_to_cold_rule: !warm ? (!ctxOk ? 'loaded with another context length (a reload)' : 'expires too soon or expiry unknown') : null };
    }
  }
  out.rule = warm ? 'warm' : 'cold';
  out.required_bytes = warm ? policy.reserve_bytes : policy.cold_runtime_bytes + policy.reserve_bytes;

  // capacity
  if (out.available_bytes === null) reasons.push('capacity_unknown: available memory is not readable');
  else if (out.available_bytes < out.required_bytes) {
    reasons.push(`insufficient_memory: available ${(out.available_bytes / GiB).toFixed(2)} GiB < required ${(out.required_bytes / GiB).toFixed(2)} GiB (${out.rule})`);
  }

  // pressure
  if (platform === 'darwin') {
    const lvl = mem.pressure && Number.isInteger(mem.pressure.level) ? mem.pressure.level : null;
    const max = warm ? policy.darwin.warm_max_pressure_level : policy.darwin.cold_max_pressure_level;
    if (lvl === null) reasons.push('pressure_unknown: kern.memorystatus_vm_pressure_level not readable');
    else if (lvl > max) reasons.push(`memory_pressure: level ${lvl} > ${max} (${out.rule})`);
  } else if (platform === 'linux') {
    const v = mem.pressure && Number.isFinite(mem.pressure.full_avg10) ? mem.pressure.full_avg10 : null;
    const max = warm ? policy.linux.warm_max_full_avg10 : policy.linux.cold_max_full_avg10;
    if (v === null) reasons.push('pressure_unknown: /proc/pressure/memory full avg10 not readable');
    else if (v > max) reasons.push(`memory_pressure: PSI full avg10 ${v} > ${max} (${out.rule})`);
  } else reasons.push(`capacity_unknown: unsupported platform ${platform}`);

  // swap
  if (out.swap_used_bytes === null) reasons.push('swap_unknown: swap use not readable');
  else if (previous && previous.memory) {
    const prev = previous.memory.swap_used_bytes;
    if (!Number.isFinite(prev)) reasons.push('swap_unknown: the previous snapshot has no swap reading');
    else {
      out.swap_growth_bytes = out.swap_used_bytes - prev;
      if (out.swap_growth_bytes > policy.swap_growth_max_bytes) reasons.push(`swap_growth: +${out.swap_growth_bytes} B > ${policy.swap_growth_max_bytes} B since the previous item`);
    }
  }
  out.admit = reasons.length === 0;
  return out;
}

module.exports = { gate, GiB };
