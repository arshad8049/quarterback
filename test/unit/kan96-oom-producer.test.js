/**
 * KAN-96 (senior 10836): the REAL producer of cgroup OOM evidence, wired into lib/sandbox/docker.js runStage.
 *
 *   - a separate trusted control channel (the start gate): the stage's stdin reaches the command byte for byte;
 *   - the observer is armed on that exact container before task code runs, and its evidence reaches the result;
 *   - observer loss (crash, hang, lost after a positive read) never blocks the work, never leaves an observer
 *     thread or gate directory behind, and never turns into "no OOM";
 *   - the fixed, bounded re-reads after a memory notification (the row-46 shape of run 45509067778).
 *
 * The runStage tests run the real runStage against a stand-in Docker CLI (test/helpers/fake-docker-gate.js) and fake
 * cgroup files; the observe() tests drive notifications and timers by hand. Nothing here needs Docker.
 */
'use strict';
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-kan96-'));
process.env.QB_DOCKER_BIN = path.join(__dirname, '..', 'helpers', 'fake-docker-gate.js');
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const D = require('../../lib/sandbox/docker');
const O = require('../../lib/sandbox/oom-observer');
const { liveGates, GATE_SCRIPT } = require('../../lib/sandbox/gate');
const { classifyStage } = require('../../lib/sandbox/states');

const IMAGE = 'fake/image:1';
const WORKERS = path.join(__dirname, '..', 'helpers', 'oom-workers');
const idsOf = (name) => fs.readFileSync(path.join(dir, `${name}.ids`), 'utf8').split('\n').filter(Boolean);
const idOf = (name) => idsOf(name).at(-1);
// a prompt that starts with the gate's own token, has NUL bytes and no final newline: the gate must not touch it
const PROMPT = Buffer.concat([Buffer.from('go\nfix the bug\n'), Buffer.from([0, 1, 2, 255]), Buffer.from('last line, no newline')]);
let n = 0;
let dir;
const roots = () => ({ cgroupRoot: path.join(dir, 'cg'), procRoot: path.join(dir, 'proc') });
const stage = (scenario, opts = {}, args = ['--user', '10001:10001', '--read-only', '--init', '-e', 'A=1', '--entrypoint', '/entry.sh', IMAGE, 'run', '--flag']) => {
  process.env.FAKE_DOCKER_SCENARIO = scenario;
  const name = `kan96u-${process.pid}-${++n}`;
  return { name, run: D.runStage(name, args, { input: PROMPT, waitTimeoutMs: 20_000, ...opts }) };
};
const created = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.create.json`), 'utf8'));
const stdinOf = (name) => fs.readFileSync(path.join(dir, `${name}.stdin.bin`));
const settled = async () => { for (let i = 0; i < 50 && O.liveObservers(); i++) await new Promise((r) => setTimeout(r, 20)); };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  process.env.FAKE_DOCKER_DIR = dir;
  process.env.FAKE_CGROUP_ROOT = path.join(dir, 'cg');
  process.env.FAKE_PROC_ROOT = path.join(dir, 'proc');
});

describe('KAN-96 runStage: the gate is a separate channel; stdin is byte-identical', () => {
  test('ungated host: the create arguments are exactly the caller\'s, stdin is exact, evidence says why it is unavailable', async () => {
    const s = stage('healthy', { oomObserver: { enabled: false } });
    const r = await s.run;
    assert.deepEqual(created(s.name), ['--name', s.name, '-i', '--user', '10001:10001', '--read-only', '--init', '-e', 'A=1', '--entrypoint', '/entry.sh', IMAGE, 'run', '--flag']);
    assert.ok(stdinOf(s.name).equals(PROMPT));
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'unavailable');
    assert.match(r.oom_unavailable, /turned off/);
    assert.equal(r.oom_evidence.gate, 'not_used');
  });

  test('a non-Linux host (Docker Desktop) says the observer is unavailable there, and is never gated', () => {
    const h = O.hostSupport({}, {}, 'darwin');
    assert.equal(h.ok, false);
    assert.match(h.why, /unavailable on this host \(darwin\)/);
    assert.equal(O.hostSupport({}, { DOCKER_HOST: 'tcp://remote:2376' }, 'linux').ok, false);
  });

  test('gated: read-only gate mount, /bin/sh gate.sh, then the ORIGINAL command; stdin byte-identical; released with "go"', async () => {
    const s = stage('healthy', { oomObserver: { force: true, ...roots() } });
    const r = await s.run;
    const a = created(s.name);
    const m = a.indexOf('--mount');
    assert.ok(m > 0, 'gate mount present');
    assert.match(a[m + 1], /^type=bind,source=[^,]+,target=\/qb-gate,readonly$/);
    assert.deepEqual(a.slice(a.indexOf('--entrypoint'), a.indexOf('--entrypoint') + 2), ['--entrypoint', '/bin/sh']);
    assert.equal(a.filter((x) => x === '--entrypoint').length, 1, 'the caller\'s entrypoint is replaced, not left to win');
    assert.deepEqual(a.slice(a.indexOf(IMAGE)), [IMAGE, '/qb-gate/gate.sh', '/entry.sh', 'run', '--flag']);
    assert.ok(a.includes('-e') && a.includes('A=1') && a.includes('--init') && a.includes('--read-only'), 'the caller\'s flags are kept');
    assert.ok(stdinOf(s.name).equals(PROMPT), 'stdin reached the command byte for byte');
    assert.ok(Buffer.from(r.stdout).equals(Buffer.from(PROMPT.toString('utf8'))), 'and came back out unchanged');
    assert.equal(fs.readFileSync(path.join(dir, `${s.name}.gate.txt`), 'utf8'), 'go\n');
    assert.equal(r.oom_evidence.gate, 'released');
    assert.equal(r.oom_evidence.observer, 'armed');
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'none', 'zero only with the final empty-cgroup read');
    assert.equal(r.oom_evidence.final, true);
    assert.equal(r.oom_evidence.container, idOf(s.name));
    await settled();
    assert.equal(O.liveObservers(), 0);
    assert.equal(liveGates(), 0);
  });

  test('no --entrypoint: the image\'s own Cmd is what the gate execs (as Docker would)', async () => {
    const s = stage('healthy', { oomObserver: { force: true, ...roots() } }, ['--init', IMAGE]);
    await s.run;
    const a = created(s.name);
    assert.deepEqual(a.slice(a.indexOf(IMAGE)), [IMAGE, '/qb-gate/gate.sh', 'sh']);
  });

  test('the gate script reads only the FIFO and execs "$@"', () => {
    assert.match(GATE_SCRIPT, /read -r qb_gate < \/qb-gate\/go \|\| exit 70/);
    assert.match(GATE_SCRIPT, /exec "\$@"\n$/);
    assert.doesNotMatch(GATE_SCRIPT, /<&0|\/dev\/stdin|read [^<]*$/m);
  });
});

describe('KAN-96 runStage: evidence from the real producer reaches the result', () => {
  test('armed before task code: a kill counted the moment the gate opens is positive (baseline 0), and Docker missing it is still oom', async () => {
    const s = stage('oom-at-once', { oomObserver: { force: true, ...roots() } });
    const r = await s.run;
    assert.equal(r.oom_evidence.baseline, 0, 'the baseline was read before the release');
    assert.equal(r.oom_killed, false);
    assert.equal(r.state, 'oom');
    assert.equal(r.oom_signal, 'cgroup');
  });

  test('a daemon that refuses the gate mount: the stage runs ungated with the caller\'s own arguments, evidence unavailable', async () => {
    const s = stage('reject-mount', { oomObserver: { force: true, ...roots() } });
    const r = await s.run;
    assert.ok(!created(s.name).includes('--mount'));
    assert.ok(stdinOf(s.name).equals(PROMPT));
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'unavailable');
    assert.match(r.oom_unavailable, /gated create failed/);
    await settled();
    assert.equal(O.liveObservers(), 0);
    assert.equal(liveGates(), 0);
  });

  test('a created container that does not run the gate is removed and recreated ungated', async () => {
    const s = stage('wrong-path', { oomObserver: { force: true, ...roots() } });
    const r = await s.run;
    assert.equal(r.oom_signal, 'unavailable');
    assert.match(r.oom_unavailable, /does not run the gate/);
    assert.ok(!created(s.name).includes('--mount'));
  });

  test('a container that never reaches the gate ends as infra_error, without hanging or leftovers', async () => {
    const s = stage('no-start', { oomObserver: { force: true, ...roots() } });
    const r = await s.run;
    assert.equal(r.state, 'infra_error');
    assert.match(r.reason, /start gate/);
    assert.equal(r.oom_signal, 'unavailable');
    await settled();
    assert.equal(O.liveObservers(), 0);
    assert.equal(liveGates(), 0);
  });
});

describe('KAN-96 runStage: observer loss (deterministic fixtures)', () => {
  for (const [file, why] of [['crash-at-arm.js', /observer lost before arming|exited/], ['hang-at-arm.js', /did not answer/]]) {
    test(`${file}: the workload still runs with exact stdin; evidence unavailable, never none; no thread or gate left`, async () => {
      const s = stage('oom-missed', { oomObserver: { force: true, ...roots(), workerFile: path.join(WORKERS, file), armTimeoutMs: 300, finishTimeoutMs: 300 } });
      const r = await s.run;
      assert.ok(stdinOf(s.name).equals(PROMPT));
      assert.equal(r.oom_evidence.gate, 'released', 'observation never blocks the work');
      assert.equal(r.oom_signal, 'unavailable', 'an OOM the observer could not see is unavailable, not none');
      assert.equal(r.state, 'completed', 'and Docker did not report it: this is the joint miss, recorded as such');
      assert.match(r.oom_unavailable, why);
      await settled();
      assert.equal(O.liveObservers(), 0);
      assert.equal(liveGates(), 0);
    });
  }

  test('a positive read survives the observer dying at finish', async () => {
    const s = stage('healthy', { oomObserver: { force: true, ...roots(), workerFile: path.join(WORKERS, 'positive-then-crash.js'), finishTimeoutMs: 300 } });
    const r = await s.run;
    assert.equal(r.state, 'oom');
    assert.equal(r.oom_signal, 'cgroup');
    assert.match(r.oom_evidence.why, /observer lost after a positive read/, 'the loss is recorded beside the positive');
    await settled();
    assert.equal(O.liveObservers(), 0);
  });
});

/** A hand-driven cgroup: files, watch callbacks and timers are all under the test's control. */
function fakeCgroup(id) {
  const files = new Map();
  const cbs = new Map();
  const timers = new Map();
  let clock = 0;
  let seq = 0;
  const dirp = `/cg/system.slice/docker-${id}.scope`;
  const set = (oom, populated) => { files.set(`${dirp}/memory.events`, `max 1\noom ${oom}\noom_kill ${oom}\n`); files.set(`${dirp}/cgroup.events`, `populated ${populated}\nfrozen 0\n`); };
  files.set('/proc/77/cgroup', `0::/system.slice/docker-${id}.scope\n`);
  files.set(`${dirp}/cgroup.procs`, '77\n');
  set(0, 1);
  const io = {
    readFile: (p) => { if (!files.has(p)) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return files.get(p); },
    watch: (p, cb) => { cbs.set(path.basename(p), cb); return { close() {} }; },
    setTimeout: (fn, ms) => { const k = ++seq; timers.set(k, { at: clock + ms, fn }); return k; },
    clearTimeout: (k) => timers.delete(k),
    now: () => clock,
  };
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = end;
  };
  return { io, set, notify: (k) => cbs.get(`${k}.events`)(), vanish: () => { for (const k of [...files.keys()]) if (k.startsWith(dirp)) files.delete(k); }, advance, timers };
}
const ID = 'c'.repeat(64);

describe('KAN-96 observe(): bounded event-triggered re-reads (frozen schedule)', () => {
  before(() => { assert.deepEqual(O.REREAD_DELAYS_MS, [1, 2, 3, 4, 6, 8, 10]); assert.equal(O.MAX_REREADS, 64); });

  test('row-46 shape: the notification reads 0, the kill lands 3 ms later, the cgroup vanishes at 6 ms: now positive', () => {
    const f = fakeCgroup(ID);
    const h = observe(f);
    f.advance(12); f.notify('memory');           // first memory notification: still 0
    f.advance(3); f.set(1, 1);                    // the kill is counted; the kernel defers the second notification
    f.advance(3); f.vanish();                     // Docker removes the cgroup before it fires
    f.advance(20);
    const r = O.finalRecord(h.record);
    assert.equal(r.last, 1);
    assert.equal(classifyStage({ Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false }, { container: ID, cgroup: r }).oom_signal, 'cgroup');
    assert.equal(f.timers.size, 0, 'no timer left after the cgroup is gone');
  });

  test('re-reads that only ever see 0 before the cgroup vanishes give unavailable, never none', () => {
    const f = fakeCgroup(ID);
    const h = observe(f);
    f.notify('memory'); f.advance(5); f.vanish(); f.advance(20);
    const r = O.finalRecord(h.record);
    assert.equal(r.last, 0);
    assert.equal(classifyStage({ Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false }, { container: ID, cgroup: r }).oom_signal, 'unavailable');
  });

  test('re-reads are bounded: 7 per notification at most, 64 per stage, and nothing without a notification', () => {
    const f = fakeCgroup(ID);
    const h = observe(f);
    f.advance(1000);
    assert.equal(h.record.rereads, 0, 'no standing polling');
    f.notify('memory'); f.advance(50);
    assert.equal(h.record.rereads, 7);
    for (let i = 0; i < 20; i++) { f.notify('memory'); f.advance(50); }
    assert.equal(h.record.rereads, 64);
    assert.equal(h.record.rereads_capped, true);
    assert.equal(f.timers.size, 0);
  });

  test('healthy exit: the empty-cgroup notification is the final read; zero is reported only then', () => {
    const f = fakeCgroup(ID);
    const h = observe(f);
    f.set(0, 0); f.notify('cgroup');
    const r = O.finalRecord(h.record);
    assert.equal(r.final, true);
    assert.equal(classifyStage({ Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false }, { container: ID, cgroup: r }).oom_signal, 'none');
  });

  test('identity and baseline: another container, an unlisted pid, or a kill already counted is not armed', () => {
    let f = fakeCgroup(ID);
    assert.equal(observe(f, 'd'.repeat(64)).armed, false);
    f = fakeCgroup(ID); f.io.readFile = ((rf) => (p) => (p.endsWith('cgroup.procs') ? '1\n' : rf(p)))(f.io.readFile);
    assert.equal(observe(f).armed, false);
    f = fakeCgroup(ID); f.set(1, 1);
    const h = observe(f);
    assert.equal(h.armed, false);
    assert.match(h.record.unavailable, /no clean baseline/);
  });
});

function observe(f, container = ID) { return O.observe({ container, pid: 77, cgroupRoot: '/cg', procRoot: '/proc' }, f.io); }

describe('KAN-96 run record: the stage evidence is kept (pipeline stageOom)', () => {
  const { stageOom } = require('../../lib/sandbox/pipeline');
  test('positive, zero and unavailable all survive with their reason; a missing stage is unavailable, never none', async () => {
    const pos = await stage('oom-at-once', { oomObserver: { force: true, ...roots() } }).run;
    assert.deepEqual([stageOom(pos).oom_signal, stageOom(pos).oom_evidence.baseline, stageOom(pos).oom_evidence.last], ['cgroup', 0, 1]);
    const zero = await stage('healthy', { oomObserver: { force: true, ...roots() } }).run;
    assert.equal(stageOom(zero).oom_signal, 'none');
    const off = await stage('healthy', { oomObserver: { enabled: false } }).run;
    assert.equal(stageOom(off).oom_signal, 'unavailable');
    assert.match(stageOom(off).oom_unavailable, /turned off/);
    assert.equal(stageOom(null).oom_signal, 'unavailable');
    assert.equal(stageOom({ state: 'completed' }).oom_signal, 'unavailable');
  });
});

describe('KAN-96 CI 45933453765: the gate directory outlives the stage until its run is removed', () => {
  // `docker cp` from a stopped container mounts its binds again: with the gate's source gone it fails
  // ("Could not find the file /git/."), which broke seed and capture on Linux CI.
  test('after runStage the (emptied) bind source still exists; removeRun of that run removes it', async () => {
    const run = `kan96run-${process.pid}`;
    const s = stage('healthy', { oomObserver: { force: true, ...roots() } }, ['--init', ...D.runLabels(run, 'workload'), IMAGE, 'run']);
    await s.run;
    const a = created(s.name);
    const src = /source=([^,]+)/.exec(a[a.indexOf('--mount') + 1])[1];
    assert.ok(fs.existsSync(src), 'the bind source is kept while the container may still be read');
    assert.deepEqual(fs.readdirSync(src), [], 'but the FIFO and script are gone');
    assert.equal(liveGates(), 0);
    await D.removeRun(run);
    assert.equal(fs.existsSync(src), false, 'removed with the run');
  });
});

describe('KAN-96 10848: the integration assertion: Docker OOMKilled=true OR validated cgroup-positive evidence from THAT container', () => {
  const { oomEvidenced } = require('../../lib/sandbox/states');
  const C = 'e'.repeat(64);
  const pos = (o = {}) => ({ state: 'oom', exit_code: 0, oom_killed: false, oom_signal: 'cgroup',
    oom_evidence: { observer: 'armed', gate: 'released', container: C, cgroup_path: `/system.slice/docker-${C}.scope`, baseline: 0, last: 1, final: true, ...o } });
  test('Docker OOMKilled=true satisfies it', () => {
    assert.equal(oomEvidenced({ state: 'oom', oom_killed: true, oom_signal: 'inspect', oom_evidence: null }, C), true);
  });
  test('validated positive evidence from the same container satisfies it', () => assert.equal(oomEvidenced(pos(), C), true));
  test('exit code alone does not (137, or the "child exit 137" a fixture prints)', () => {
    assert.equal(oomEvidenced({ state: 'execution_error', exit_code: 137, oom_killed: false, oom_signal: 'unavailable', stdout: 'child exit 137' }, C), false);
    assert.equal(oomEvidenced({ state: 'oom', exit_code: 137, oom_killed: false, oom_signal: 'unavailable', oom_evidence: { observer: 'armed', container: C } }, C), false);
  });
  test('unavailable does not, whatever else the record claims', () => {
    assert.equal(oomEvidenced({ ...pos(), oom_signal: 'unavailable' }, C), false);
    assert.equal(oomEvidenced(pos({ observer: 'not_armed' }), C), false);
    assert.equal(oomEvidenced(pos({ observer: 'not_used', gate: 'not_used' }), C), false);
  });
  test('the known injected fixture type does not: a case label or a state of "oom" is not evidence', () => {
    assert.equal(oomEvidenced({ case: 'oom', truth: 'oom', state: 'oom', oom_killed: false, oom_signal: 'cgroup' }, C), false);
    assert.equal(oomEvidenced({ state: 'oom', oom_killed: false }, C), false);
  });
  test('evidence for another container, or one not named after it, or without a clean baseline, does not', () => {
    assert.equal(oomEvidenced(pos(), 'f'.repeat(64)), false);
    assert.equal(oomEvidenced(pos(), undefined), false);
    assert.equal(oomEvidenced(pos({ cgroup_path: '/system.slice/docker-other.scope' }), C), false);
    assert.equal(oomEvidenced(pos({ baseline: 1, last: 2 }), C), false);
    assert.equal(oomEvidenced(pos({ baseline: null }), C), false);
    assert.equal(oomEvidenced(pos({ last: 0 }), C), false);
    assert.equal(oomEvidenced(pos({ last: '1' }), C), false);
    assert.equal(oomEvidenced(null, C), false);
  });
  test('through the real producer: Docker missed it, the observer saw it: satisfied only for that container', async () => {
    const s = stage('oom-at-once', { oomObserver: { force: true, ...roots() } });
    const r = await s.run;
    assert.equal(oomEvidenced(r, idOf(s.name)), true);
    assert.equal(oomEvidenced(r, 'f'.repeat(64)), false);
  });
  test('through the real producer: the same OOM with the observer unavailable is not satisfied (joint miss stays a failure)', async () => {
    const s = stage('oom-missed', { oomObserver: { enabled: false } });
    const r = await s.run;
    assert.equal(r.oom_killed, false);
    assert.equal(oomEvidenced(r, idOf(s.name)), false);
  });
});

describe('KAN-96 10848: the ungated fallback is unavailable and never reuses the replaced container\'s evidence', () => {
  const { oomEvidenced } = require('../../lib/sandbox/states');
  for (const scenario of ['wrong-path', 'reject-mount']) {
    test(`${scenario}: recorded unavailable, bound to the container that ran, nothing from a replaced one`, async () => {
      const s = stage(scenario, { oomObserver: { force: true, ...roots() } });
      const r = await s.run;
      const ids = scenario === 'wrong-path' ? idsOf(s.name) : [idOf(s.name)];
      if (scenario === 'wrong-path') assert.equal(ids.length, 2, 'the gated container was replaced');
      const ran = ids.at(-1);
      assert.equal(r.oom_signal, 'unavailable');
      assert.match(r.oom_unavailable, /not gated/);
      assert.deepEqual([r.oom_evidence.gate, r.oom_evidence.observer], ['not_used', 'not_used']);
      assert.equal(r.oom_evidence.container, ran, 'the evidence names the container that actually ran');
      assert.deepEqual([r.oom_evidence.baseline, r.oom_evidence.last, r.oom_evidence.final, r.oom_evidence.reads], [null, null, false, 0]);
      for (const id of ids) assert.equal(oomEvidenced(r, id), false);
      if (scenario === 'wrong-path') {
        // the replaced container's cgroup said oom_kill 1: it must not appear anywhere in the result
        assert.equal(JSON.stringify(r).includes(ids[0]), false, 'no trace of the replaced container');
        assert.equal(r.state, 'completed');
      }
      assert.ok(stdinOf(s.name).equals(PROMPT));
      await settled();
      assert.equal(O.liveObservers(), 0);
      assert.equal(liveGates(), 0);
    });
  }
});

describe('KAN-96 10848: gate setup leaves the original command, permissions and stdin unchanged', () => {
  const CALLER = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
    '--init', '--pids-limit', '64', '-e', 'A=1', '-v', 'vol:/work:ro', '-w', '/work', '--entrypoint', '/entry.sh', IMAGE, 'run', '--flag', 'with space', ''];
  test('every caller flag is kept, in order; only the gate mount and /bin/sh entrypoint are added; the command is exact', async () => {
    const s = stage('healthy', { oomObserver: { force: true, ...roots() } }, CALLER);
    await s.run;
    const a = created(s.name).slice(3);   // after --name <name> -i
    const callerFlags = CALLER.slice(0, CALLER.indexOf('--entrypoint'));
    const m = a.indexOf('--mount');
    assert.deepEqual(a.slice(0, m), callerFlags, 'user, capabilities, no-new-privileges, read-only root, tmpfs, init, pids, env, mounts, workdir: unchanged');
    assert.deepEqual(a.slice(m + 2, m + 4), ['--entrypoint', '/bin/sh']);
    assert.equal(a.length, m + 4 + 1 + 1 + 5, 'nothing else added: image, gate.sh, the five original argv entries');
    assert.deepEqual(a.slice(a.indexOf(IMAGE) + 1), ['/qb-gate/gate.sh', '/entry.sh', 'run', '--flag', 'with space', '']);
    assert.ok(stdinOf(s.name).equals(PROMPT));
  });
  test('the gate directory, script and FIFO: owned by the host user, 0755 / 0644 / 0644 FIFO, mounted read-only', () => {
    const { openGate } = require('../../lib/sandbox/gate');
    const g = openGate();
    try {
      const st = (f) => fs.statSync(path.join(g.dir, f));
      assert.equal(fs.statSync(g.dir).mode & 0o777, 0o755);
      assert.equal(st('gate.sh').mode & 0o777, 0o644);
      assert.equal(st('go').mode & 0o777, 0o644);
      assert.equal(st('go').isFIFO(), true);
      if (typeof process.getuid === 'function') for (const f of ['gate.sh', 'go']) assert.equal(st(f).uid, process.getuid());
      assert.match(g.mountArgs[1], /,readonly$/);
      assert.deepEqual(fs.readdirSync(g.dir).sort(), ['gate.sh', 'go']);
    } finally { g.cleanup(); }
    assert.equal(fs.existsSync(g.dir), false);
  });
});
