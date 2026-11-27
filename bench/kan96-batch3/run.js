#!/usr/bin/env node
/**
 * KAN-96 batch 3 (10836): the REAL producer, lib/sandbox/docker.js runStage, at most 50 sequential iterations over
 * the fixed allocation in config.json (frozen before the request commit). The schedule and caps are checked against
 * the code before anything runs. No experiment harness, no gate on stdin, no secrets, no model, no retries.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const D = require('../../lib/sandbox/docker');
const O = require('../../lib/sandbox/oom-observer');
const { liveGates } = require('../../lib/sandbox/gate');
const CFG = require('./config.json');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out');
if (!OUT) { console.error('usage: run.js --out <dir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

// the frozen schedule must be the one in the code
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!same(CFG.observer.reread_delays_ms, O.REREAD_DELAYS_MS) || CFG.observer.max_rereads_per_stage !== O.MAX_REREADS
  || CFG.observer.arm_timeout_ms !== O.ARM_TIMEOUT_MS || CFG.observer.finish_timeout_ms !== O.FINISH_TIMEOUT_MS) throw new Error('config.json does not match the observer code');

const IMAGE = 'busybox:1.36.1';
const DIAG = `kan96b3-${process.env.GITHUB_RUN_ID || 'local'}-${process.pid}`;
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
  '--network', 'none', '--init', '--pids-limit', '64', '--memory', '32m', '--memory-swap', '32m', '--label', `qb.diag=${DIAG}`];
const OOM = '(echo 1000 > /proc/self/oom_score_adj; exec dd if=/dev/zero of=/dev/null bs=64M count=1 2>/dev/null); echo "child exit $?"; exit 0';
const CMD = { oom: OOM, observer_unavailable: OOM, healthy: 'cat | sha256sum; exit 0', sigkill: '(sleep 5 & kill -9 $!; wait $!); echo "child exit $?"; exit 0' };
// stdin for every case: starts with the gate's own token, has NUL bytes and no final newline
const PROMPT = Buffer.concat([Buffer.from('go\nKAN-96 batch 3 prompt\n'), Buffer.from([0, 1, 2, 255]), Buffer.from('no final newline')]);
const PROMPT_SHA = crypto.createHash('sha256').update(PROMPT).digest('hex');
const plan = [];   // interleaved, so one case does not own one stretch of time
for (let left = CFG.cases.map((c) => ({ c, n: c.n })); left.some((x) => x.n > 0);) for (const x of left) if (x.n > 0) { plan.push(x.c); x.n--; }
if (plan.length > CFG.max_iterations) throw new Error('more than 50 iterations');
const LIMIT = Number(arg('--limit', plan.length));   // local smoke only; the workflow passes none
const text = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20_000 }); return r.status === 0 ? r.stdout.trim() : `unavailable (${r.error ? r.error.code : r.status})`; };
const gateDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qb-gate-')).length;
let stopping = null;
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopping = s; });

async function one(c, i) {
  const run = `${DIAG}-${i}`; const row = { i, case: c.name, truth: c.truth, run };
  const t0 = process.hrtime.bigint();
  try {
    const r = await D.runStage(`${run}-w`, [...HARDEN, ...D.runLabels(run, 'workload'), IMAGE, 'sh', '-c', CMD[c.name]],
      { input: PROMPT, waitTimeoutMs: CFG.stage_wait_timeout_ms, maxBytes: 64 * 1024, ...(c.cgroupRoot ? { oomObserver: { cgroupRoot: c.cgroupRoot } } : {}) });
    row.wall_ms = +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);
    Object.assign(row, { state: r.state, reason: r.reason, exit_code: r.exit_code, oom_killed: r.oom_killed, oom_signal: r.oom_signal, oom_unavailable: r.oom_unavailable || null,
      stdout: r.stdout.trim().slice(0, 200), stderr: r.stderr.trim().slice(0, 200), duration_ms: r.duration_ms, ev: r.oom_evidence });
    if (c.name === 'healthy') row.stdin_exact = row.stdout.split(/\s+/)[0] === PROMPT_SHA;
  } catch (e) { row.error = String(e.stack || e); }
  const left = await D.removeRun(run);
  row.cleanup = { ...left, complete: D.removed(left), observers_live: O.liveObservers(), gates_live: liveGates(), gate_dirs: gateDirs() };
  return row;
}

const stats = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? { n: v.length, median: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : null; };

async function main() {
  const pull = await D.op(['pull', '-q', IMAGE], { timeoutMs: 120_000 });
  const v = (f) => text('docker', ['version', '--format', f]);
  const env = { commit: text('git', ['rev-parse', 'HEAD']), branch: process.env.GITHUB_REF_NAME || null, github_run: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    runner_image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ''}`.trim() : 'unavailable', kernel: text('uname', ['-r']), arch: os.arch(), cpus: os.cpus().length, node: process.version,
    docker: v('{{.Server.Version}}'), components: v('{{range .Server.Components}}{{.Name}} {{.Version}}; {{end}}'), cgroup: text('docker', ['info', '--format', '{{.CgroupVersion}} {{.CgroupDriver}}']),
    image: text('docker', ['image', 'inspect', '-f', '{{.Id}}', IMAGE]), host_support: O.hostSupport(), config: CFG, prompt_sha256: PROMPT_SHA };
  fs.writeFileSync(path.join(OUT, 'environment.json'), `${JSON.stringify(env, null, 2)}\n`);
  if (!pull.ok) throw new Error('image pull failed');
  const t0 = Date.now(); const rows = []; const log = fs.createWriteStream(path.join(OUT, 'iterations.jsonl'));
  for (let i = 1; i <= Math.min(plan.length, LIMIT); i++) {
    if (stopping || Date.now() - t0 > CFG.time_budget_min * 60_000) break;
    const row = await one(plan[i - 1], i); rows.push(row); log.write(`${JSON.stringify(row)}\n`);
    console.log(JSON.stringify({ i, case: row.case, state: row.state, signal: row.oom_signal, insp: row.oom_killed, gate: row.ev && row.ev.gate, obs: row.ev && row.ev.observer, last: row.ev && row.ev.last, final: row.ev && row.ev.final, why: row.oom_unavailable, clean: row.cleanup.complete, error: row.error }));
  }
  await new Promise((r) => log.end(r));
  const by = {};
  for (const c of CFG.cases) {
    const r = rows.filter((x) => x.case === c.name); const n = (f) => r.filter(f).length;
    const pos = (x) => x.ev && x.ev.baseline === 0 && x.ev.last > 0;
    by[c.name] = { ran: r.length, errors: n((x) => x.error), gate_released: n((x) => x.ev && x.ev.gate === 'released'), armed: n((x) => x.ev && x.ev.observer === 'armed'),
      observer_positive: n(pos), final_observation: n((x) => x.ev && x.ev.final), docker_oom: n((x) => x.oom_killed === true), decided_oom: n((x) => x.state === 'oom'),
      ...(c.truth === 'oom' ? { docker_missed: n((x) => x.oom_killed === false), observer_missed: n((x) => !pos(x)), joint_missed: n((x) => x.oom_killed === false && !pos(x)),
        corroborated_137: n((x) => /child exit 137/.test(x.stdout || '')) } : { false_positive: n((x) => x.state === 'oom' || pos(x) || x.oom_killed === true) }),
      wrong: n((x) => (c.truth === 'oom' ? x.oom_signal === 'none' : x.state === 'oom')), signals: r.reduce((o, x) => { const k = x.oom_signal || 'error'; o[k] = (o[k] || 0) + 1; return o; }, {}),
      states: r.reduce((o, x) => { const k = x.state || 'error'; o[k] = (o[k] || 0) + 1; return o; }, {}), stdin_exact: c.name === 'healthy' ? n((x) => x.stdin_exact) : undefined,
      rereads_max: Math.max(0, ...r.map((x) => (x.ev && x.ev.rereads) || 0)), rereads_capped: n((x) => x.ev && x.ev.rereads_capped), reads_max: Math.max(0, ...r.map((x) => (x.ev && x.ev.reads) || 0)),
      gate_ms: stats(r.map((x) => x.ev && x.ev.gate_ms)), arm_ms: stats(r.map((x) => x.ev && x.ev.arm_ms)), observer_active_ms: stats(r.map((x) => x.ev && x.ev.observer_active_ms)), wall_ms: stats(r.map((x) => x.wall_ms)),
      cleanup_complete: n((x) => x.cleanup.complete), observers_left_max: Math.max(0, ...r.map((x) => x.cleanup.observers_live)), gates_left_max: Math.max(0, ...r.map((x) => x.cleanup.gates_live)), gate_dirs_max: Math.max(0, ...r.map((x) => x.cleanup.gate_dirs)) };
  }
  const leftover = text('docker', ['ps', '-aq', '--filter', `label=qb.diag=${DIAG}`]);
  const summary = { planned: plan.length, ran: rows.length, stopped_by: stopping || (rows.length < Math.min(plan.length, LIMIT) ? 'time budget' : rows.length < plan.length ? 'local --limit' : null), cases: by, containers_left_at_end: leftover ? leftover.split('\n').filter(Boolean).length : 0, gate_dirs_at_end: gateDirs(), observers_at_end: O.liveObservers() };
  fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (rows.some((r) => !r.cleanup.complete)) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
