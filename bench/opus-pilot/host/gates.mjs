/**
 * KAN-113 10596: evaluate a host-qualification report. Gates run in order; the first failure is the blocker
 * and every later gate is reported "not_reached" (none is skipped silently). Pure function, no I/O.
 */
const GiB = 1024 ** 3;
export const MIN_DISK_FREE_BYTES = 5 * GiB;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const GATES = [
  ['host', (r) => { const h = r.host || {}; const p = [];
    if (h.arch !== 'x86_64') p.push(`architecture ${h.arch} (need x86_64)`);
    for (const k of ['kernel', 'docker']) if (!h[k]) p.push(`${k} not recorded`);
    if (!(h.mem_available_bytes > 0)) p.push('MemAvailable not recorded');
    return p; }],
  ['disk', (r) => { const f = r.host && r.host.disk_free_bytes_after;
    return f >= MIN_DISK_FREE_BYTES ? [] : [`free disk after setup ${f == null ? 'not recorded' : (f / GiB).toFixed(2) + ' GiB'} (need ≥ 5 GiB)`]; }],
  ['admission', (r) => { const a = r.admission || {};
    if (!a.ok) return [`admission refused: ${a.reason || 'unknown'}`];
    return a.memory_checked === true ? [] : ['admission passed without checking memory (fail closed)']; }],
  ['images', (r) => ['tools', 'agent', 'proxy', 'fake_cli'].filter((k) => !DIGEST.test((r.images || {})[k] || '')).map((k) => `image ${k} has no recorded Id`)],
  ['pipeline', (r) => { const p = r.pipeline || {}; const out = [];
    if (p.status !== 'completed') out.push(`fake-CLI pipeline status ${p.status}`);
    if (p.credential_mode !== 'none') out.push(`credential mode ${p.credential_mode} (must be none)`);
    if (p.classification !== 'verified') out.push(`stream classification ${p.classification}`);
    if (!p.fake_change_captured) out.push('fake agent change not captured');
    if (!p.leftovers_removed) out.push('pipeline left resources behind');
    return out; }],
  ['cleanup', (r) => ['normal', 'refusal', 'timeout', 'cancellation', 'crash'].filter((k) => (r.cleanup || {})[k] !== true).map((k) => `cleanup case ${k} left resources or did not run`)],
  ['isolation', (r) => { const i = r.isolation || {}; const out = [];
    if (i.bash_normal_mode_blocks_dummy !== true) out.push(`Bash sandbox (normal mode) did not block the dummy credential${i.bash_detail ? `: ${i.bash_detail}` : ''}`);
    if (i.file_tools_enforced !== true) out.push(`file-tool and resolved-path enforcement not shown${i.file_tools_detail ? `: ${i.file_tools_detail}` : ''}`);
    return out; }],
];

export function evaluateHost(report) {
  const gates = []; let first = null;
  for (const [gate, check] of GATES) {
    if (first) { gates.push({ gate, status: 'not_reached' }); continue; }
    let problems; try { problems = check(report || {}); } catch (e) { problems = [`gate error: ${e.message}`]; }
    if (problems.length) { first = { gate, problems }; gates.push({ gate, status: 'failed', problems }); }
    else gates.push({ gate, status: 'passed' });
  }
  return { passed: !first, first_blocker: first, gates };
}
