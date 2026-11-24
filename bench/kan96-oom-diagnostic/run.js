#!/usr/bin/env node
/**
 * KAN-96 diagnostic (senior 10807): the OOM fixture of test/integration/qb02-sandbox-docker.test.js, N times, with
 * the container's own memory.events sampled from the host. Evidence only: no product code is changed, no rerun until
 * green. The fixture command and flags are copied unchanged; two things are added, both outside the workload: a
 * label (for exact cleanup) and a 60 s wait limit on the stage.
 *
 * Usage: node run.js --out <dir> [--n 50] [--budget-min 22]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const D = require('../../lib/sandbox/docker');
const { conclude } = require('./sampler');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out'); const N = Math.min(50, Number(arg('--n', 50))); const BUDGET = Number(arg('--budget-min', 22)) * 60_000;
if (!OUT) { console.error('usage: run.js --out <dir> [--n 50]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const IMAGE = 'busybox:1.36.1';
const DIAG = `kan96-${process.env.GITHUB_RUN_ID || 'local'}-${process.pid}`;
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--network', 'none', '--init', '--pids-limit', '64'];
const CMD = ['sh', '-c', '(echo 1000 > /proc/self/oom_score_adj; exec dd if=/dev/zero of=/dev/null bs=64M count=1 2>/dev/null); echo "child exit $?"; exit 0'];
const text = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20_000 }); return r.status === 0 ? r.stdout.trim() : `unavailable (${r.error ? r.error.code : r.status})`; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const environment = () => ({
  commit: text('git', ['rev-parse', 'HEAD']), branch: process.env.GITHUB_REF_NAME || text('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
  github_run: process.env.GITHUB_RUN_ID || null, runner_image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ''}`.trim() : 'unavailable',
  kernel: text('uname', ['-r']), arch: os.arch(), os: text('uname', ['-sv']), cpus: os.cpus().length, node: process.version,
  docker: JSON.parse(text('docker', ['version', '--format', '{{json .Server}}']).replace(/^unavailable.*/, 'null')),
  cgroup: text('docker', ['info', '--format', '{{.CgroupVersion}} {{.CgroupDriver}}']), runtime: text('docker', ['info', '--format', '{{.DefaultRuntime}} {{json .Runtimes}}']),
  cgroup_fs: text('stat', ['-fc', '%T', '/sys/fs/cgroup']), image: text('docker', ['image', 'inspect', '-f', '{{.Id}} {{json .RepoDigests}}', IMAGE]),
});

let stopping = null;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = sig; });

async function main() {
  const pull = await D.op(['pull', '-q', IMAGE], { timeoutMs: 120_000 });
  const env = environment();
  fs.writeFileSync(path.join(OUT, 'environment.json'), `${JSON.stringify(env, null, 2)}\n`);
  console.log(JSON.stringify(env));
  if (!pull.ok) throw new Error('image pull failed');
  const worker = new Worker(path.join(__dirname, 'worker.js'));
  await new Promise((r) => worker.once('message', r));
  // docker events: container identity before the start call, and the daemon's own oom/die events with their times
  const listeners = new Set();
  const ev = spawn('docker', ['events', '--filter', `label=qb.diag=${DIAG}`, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  ev.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const e = JSON.parse(l); for (const f of listeners) f(e); } catch { /* partial */ } } });
  await wait(1500);

  const t0 = Date.now(); const rows = [];
  const log = fs.createWriteStream(path.join(OUT, 'iterations.jsonl'));
  for (let i = 1; i <= N; i++) {
    if (stopping || Date.now() - t0 > BUDGET) break;
    const run = `${DIAG}-${i}`; const events = []; let sampled = null; let resolveSample; const got = new Promise((r) => { resolveSample = r; });
    const stop = new SharedArrayBuffer(4);
    const on = (e) => {
      if (!e.Actor || (e.Actor.Attributes || {})['qb.run'] !== run) return;
      events.push({ action: e.Action, time_nano: e.timeNano, exit: e.Actor.Attributes.exitCode ?? null });
      if (e.Action === 'create') { worker.once('message', (m) => { sampled = m; resolveSample(); }); worker.postMessage({ id: e.Actor.ID, stop }); }
    };
    listeners.add(on);
    const row = { i, run, started: new Date().toISOString() };
    try {
      const r = await D.runStage(`${run}-oom`, [...HARDEN, ...D.runLabels(run, 'workload'), '--label', `qb.diag=${DIAG}`, '--memory', '32m', '--memory-swap', '32m', IMAGE, ...CMD], { waitTimeoutMs: 60_000 });
      row.stage = { state: r.state, reason: r.reason, exit_code: r.exit_code, oom_killed: r.oom_killed, stdout: r.stdout.trim(), stderr: r.stderr.trim().slice(0, 300), duration_ms: r.duration_ms };
      const pick = (s) => (s ? { OOMKilled: s.OOMKilled, ExitCode: s.ExitCode, Status: s.Status, FinishedAt: s.FinishedAt } : 'unavailable');
      row.inspect_after_stage = pick(await D.inspectState(`${run}-oom`));
      if (!r.oom_killed) { await wait(5000); row.inspect_5s_later = pick(await D.inspectState(`${run}-oom`)); }
      await Promise.race([got, wait(3000)]);
      Atomics.store(new Int32Array(stop), 0, 1);
      if (!sampled && events.some((e) => e.action === 'create')) await Promise.race([got, wait(2000)]);
    } catch (e) { row.error = String(e.message || e); } finally {
      Atomics.store(new Int32Array(stop), 0, 1);
      listeners.delete(on);
      const left = await D.removeRun(run);
      row.cleanup = { ...left, complete: D.removed(left) };
    }
    row.docker_events = events;
    row.sample = sampled || { ended: events.some((e) => e.action === 'create') ? 'unavailable: the sampler returned nothing' : 'unavailable: no create event was seen' };
    row.cgroup = conclude(row.sample);
    const childKilled = /child exit 137/.test((row.stage && row.stage.stdout) || '');
    row.outcome = { child_exit_137: childKilled, inspect_oom: row.stage ? row.stage.oom_killed : 'unknown', cgroup_oom_kill: row.cgroup.oom_kill, docker_oom_event: events.some((e) => e.action === 'oom') };
    row.disagree = row.stage && !row.stage.oom_killed && (row.cgroup.oom_kill > 0 || childKilled);
    rows.push(row); log.write(`${JSON.stringify(row)}\n`);
    console.log(JSON.stringify({ i, ...row.outcome, state: row.stage && row.stage.state, sample_end: row.sample.ended, clean: row.cleanup.complete, disagree: row.disagree }));
  }
  await new Promise((r) => log.end(r));
  ev.kill(); await worker.terminate();
  const n = (f) => rows.filter(f).length;
  const summary = { planned: N, ran: rows.length, stopped_by: stopping || (rows.length < N ? 'time budget' : null),
    classified_oom: n((r) => r.stage && r.stage.state === 'oom'), classified_other: n((r) => r.stage && r.stage.state !== 'oom'), errors: n((r) => r.error),
    child_exit_137: n((r) => r.outcome.child_exit_137), inspect_false_but_137: n((r) => r.stage && !r.stage.oom_killed && r.outcome.child_exit_137),
    cgroup_positive: n((r) => r.cgroup.oom_kill > 0), cgroup_zero: n((r) => r.cgroup.oom_kill === 0), cgroup_unknown: n((r) => r.cgroup.oom_kill === 'unknown'),
    baseline_zero_read: n((r) => r.cgroup.baseline_before_workload === true), path_validated: n((r) => r.sample.resolved && r.sample.resolved.name_has_full_id && r.sample.resolved.pid_listed),
    disagreements: rows.filter((r) => r.disagree).map((r) => r.i), later_inspect_true: rows.filter((r) => r.inspect_5s_later && r.inspect_5s_later.OOMKilled === true).map((r) => r.i),
    docker_oom_event: n((r) => r.outcome.docker_oom_event), cleanup_complete: n((r) => r.cleanup.complete) };
  fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.cleanup_complete !== rows.length) process.exitCode = 1;   // a leak fails the job; a misclassification is the data, not a failure
}
main().catch((e) => { console.error(e); process.exit(1); });
