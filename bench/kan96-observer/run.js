#!/usr/bin/env node
/**
 * KAN-96 observer experiment (10813): at most 50 sequential iterations over four cases. The workload waits on one line
 * of stdin (a gate, disclosed: `read _` before the original command) until the observer is armed; the observer runs
 * on the host. No product code is used for the observation. No secrets, no model.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const D = require('../../lib/sandbox/docker');
const { classifyStage } = require('../../lib/sandbox/states');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out'); const BUDGET = Number(arg('--budget-min', 20)) * 60_000; const SCALE = Number(arg('--scale', 1));
if (!OUT) { console.error('usage: run.js --out <dir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const IMAGE = 'busybox:1.36.1';
const DIAG = `kan96o-${process.env.GITHUB_RUN_ID || 'local'}-${process.pid}`;
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
  '--network', 'none', '--init', '--pids-limit', '64', '--memory', '32m', '--memory-swap', '32m'];
const OOM = '(echo 1000 > /proc/self/oom_score_adj; exec dd if=/dev/zero of=/dev/null bs=64M count=1 2>/dev/null); echo "child exit $?"; exit 0';
const CASES = [
  { name: 'oom', n: 30, cmd: OOM, truth: 'oom' },
  { name: 'healthy', n: 8, cmd: 'echo done; exit 0', truth: 'no_oom' },
  { name: 'sigkill', n: 6, cmd: '(sleep 5 & kill -9 $!; wait $!); echo "child exit $?"; exit 0', truth: 'no_oom' },
  { name: 'observer_unavailable', n: 6, cmd: OOM, truth: 'oom', root: '/nonexistent-cgroup-root' },
];
const plan = [];   // interleaved, so one case does not own one stretch of time
for (let left = CASES.map((c) => ({ c, n: Math.max(1, Math.round(c.n * SCALE)) })); left.some((x) => x.n > 0);) for (const x of left) if (x.n > 0) { plan.push(x.c); x.n--; }
if (plan.length > 50) throw new Error('more than 50 iterations');
const text = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20_000 }); return r.status === 0 ? r.stdout.trim() : `unavailable (${r.error ? r.error.code : r.status})`; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = null;
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopping = s; });

async function one(c, i, worker) {
  const run = `${DIAG}-${i}`; const name = `${run}-w`; const row = { i, case: c.name, truth: c.truth, run };
  const ask = (msg, ms) => Promise.race([new Promise((r) => { worker.once('message', r); worker.postMessage(msg); }), wait(ms).then(() => null)]);
  try {
    const cr = await D.op(['create', '--name', name, '-i', ...HARDEN, ...D.runLabels(run, 'workload'), '--label', `qb.diag=${DIAG}`, IMAGE, 'sh', '-c', `read _; ${c.cmd}`]);
    if (!cr.ok) throw new Error(`create: ${cr.stderr.slice(0, 200)}`);
    const id = cr.stdout.trim();
    const p = spawn('docker', ['start', '-ai', name], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.resume();
    const closed = new Promise((r) => p.on('close', r));
    let st = null; const t = Date.now();
    while (Date.now() - t < 5000) { st = await D.inspectState(name); if (st && st.Running && st.Pid > 0) break; await wait(10); }
    row.container = id; row.pid = st && st.Pid;
    const a = st && st.Running ? await ask({ arm: { container: id, pid: st.Pid, ...(c.root ? { root: c.root } : {}) } }, 3000) : null;
    row.armed = Boolean(a && a.armed); row.arm_why = a ? a.why : 'the observer did not answer';
    const admitted = process.hrtime.bigint();
    p.stdin.end('\n');   // admit the workload (also when the observer is unavailable: observation never blocks the work)
    const killer = setTimeout(() => { D.op(['kill', name]); }, 60_000);
    await closed; clearTimeout(killer);
    row.workload_ms = Number(process.hrtime.bigint() - admitted) / 1e6;
    await wait(300);
    const f = await ask({ finish: true }, 3000);
    row.observer = f ? f.record : { container: id, unavailable: 'the observer did not answer' };
    let s = await D.inspectState(name); s = await D.settleOom(name, s);
    row.inspect = s ? { OOMKilled: s.OOMKilled, ExitCode: s.ExitCode, Status: s.Status } : 'unavailable';
    row.stdout = out.trim();
    row.decision = classifyStage(s, { container: id, cgroup: row.observer });
    row.before = classifyStage(s, {}).state;
  } catch (e) { row.error = String(e.message || e); } finally { const left = await D.removeRun(run); row.cleanup = { ...left, complete: D.removed(left) }; }
  return row;
}

async function main() {
  const pull = await D.op(['pull', '-q', IMAGE], { timeoutMs: 120_000 });
  const v = (f) => text('docker', ['version', '--format', f]);
  const env = { commit: text('git', ['rev-parse', 'HEAD']), branch: process.env.GITHUB_REF_NAME || null, github_run: process.env.GITHUB_RUN_ID || null, runner_image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ''}`.trim() : 'unavailable',
    kernel: text('uname', ['-r']), arch: os.arch(), cpus: os.cpus().length, node: process.version, docker: v('{{.Server.Version}}'), components: v('{{range .Server.Components}}{{.Name}} {{.Version}}; {{end}}'), cgroup: text('docker', ['info', '--format', '{{.CgroupVersion}} {{.CgroupDriver}}']), image: text('docker', ['image', 'inspect', '-f', '{{.Id}}', IMAGE]) };
  fs.writeFileSync(path.join(OUT, 'environment.json'), `${JSON.stringify(env, null, 2)}\n`);
  if (!pull.ok) throw new Error('image pull failed');
  const worker = new Worker(path.join(__dirname, 'observer.js'));
  await new Promise((r) => worker.once('message', r));
  const t0 = Date.now(); const rows = []; const log = fs.createWriteStream(path.join(OUT, 'iterations.jsonl'));
  for (let i = 1; i <= plan.length; i++) {
    if (stopping || Date.now() - t0 > BUDGET) break;
    const row = await one(plan[i - 1], i, worker); rows.push(row); log.write(`${JSON.stringify(row)}\n`);
    console.log(JSON.stringify({ i, case: row.case, armed: row.armed, state: row.decision && row.decision.state, signal: row.decision && row.decision.oom_signal, last: row.observer && row.observer.last, final: row.observer && row.observer.final, inspect: row.inspect && row.inspect.OOMKilled, why: row.observer && row.observer.unavailable, clean: row.cleanup.complete, error: row.error }));
  }
  await new Promise((r) => log.end(r)); await worker.terminate();
  const by = {};
  for (const c of CASES) {
    const r = rows.filter((x) => x.case === c.name); const n = (f) => r.filter(f).length;
    const act = r.map((x) => x.observer && x.observer.observer_active_ms).filter(Number.isFinite).sort((a, b) => a - b);
    by[c.name] = { ran: r.length, errors: n((x) => x.error), armed: n((x) => x.armed), observer_positive: n((x) => x.observer && x.observer.baseline === 0 && x.observer.last > 0), final_observation: n((x) => x.observer && x.observer.final === true),
      inspect_oom: n((x) => x.inspect && x.inspect.OOMKilled === true), docker_not_reported: c.truth === 'oom' ? n((x) => x.inspect && x.inspect.OOMKilled === false) : undefined,
      decided_oom: n((x) => x.decision && x.decision.state === 'oom'), wrong: n((x) => x.decision && (c.truth === 'oom' ? x.decision.oom_signal === 'none' : x.decision.state === 'oom')),
      signals: r.reduce((o, x) => { const k = x.decision ? x.decision.oom_signal : 'error'; o[k] = (o[k] || 0) + 1; return o; }, {}), observer_active_ms_median: act.length ? act[Math.floor(act.length / 2)] : null, observer_active_ms_max: act.length ? act[act.length - 1] : null,
      arm_ms_max: Math.max(0, ...r.map((x) => (x.observer && x.observer.arm_ms) || 0)), reads_max: Math.max(0, ...r.map((x) => (x.observer && x.observer.reads) || 0)), cleanup_complete: n((x) => x.cleanup.complete) };
  }
  const summary = { planned: plan.length, ran: rows.length, stopped_by: stopping || (rows.length < plan.length ? 'time budget' : null), cases: by };
  fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (rows.some((r) => !r.cleanup.complete)) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
