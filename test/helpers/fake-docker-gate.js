#!/usr/bin/env node
/**
 * fake-docker-gate.js — TEST ONLY. A stand-in Docker CLI for KAN-96 runStage unit tests (QB_DOCKER_BIN), so the real
 * producer (lib/sandbox/docker.js runStage) runs end to end without Docker: create, inspect, image inspect, start -a
 * [-i], kill, wait, rm. `start` behaves like a container: if the create arguments carry the gate mount it opens that
 * FIFO and waits for "go" exactly as gate.sh does, then runs the "workload" (stdin copied to stdout and saved).
 * Fake cgroup files (FAKE_CGROUP_ROOT, FAKE_PROC_ROOT) stand in for the host's /sys/fs/cgroup and /proc.
 *
 *   FAKE_DOCKER_DIR       state directory (required)
 *   FAKE_DOCKER_SCENARIO  healthy | oom-missed | oom-at-once | no-start | reject-mount | wrong-path
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.FAKE_DOCKER_DIR;
const SCEN = process.env.FAKE_DOCKER_SCENARIO || 'healthy';
const IMAGE = 'fake/image:1';
const PID = 4242;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(DIR, 'calls.jsonl'), `${JSON.stringify(argv)}\n`);
// a new id for every create (a replaced container never shares its predecessor's id); <name>.ids lists them in order
const newId = (name) => {
  const f = path.join(DIR, `${name}.ids`);
  const ids = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  const id = crypto.createHash('sha256').update(`${name}#${ids.length}`).digest('hex');
  fs.appendFileSync(f, `${id}\n`);
  return id;
};
const idOf = (name) => fs.readFileSync(path.join(DIR, `${name}.ids`), 'utf8').split('\n').filter(Boolean).pop();
const file = (name, ext) => path.join(DIR, `${name}.${ext}`);
const nameOf = (x) => { const m = path.join(DIR, `id-${x}`); return fs.existsSync(m) ? fs.readFileSync(m, 'utf8') : x; };
const readState = (name) => JSON.parse(fs.readFileSync(file(name, 'state.json'), 'utf8'));
const writeState = (name, st) => fs.writeFileSync(file(name, 'state.json'), JSON.stringify(st));
const cgDir = (id) => path.join(process.env.FAKE_CGROUP_ROOT, 'system.slice', `docker-${id}.scope`);
// Atomic, like a kernfs read: writeFileSync truncates first, and an observer woken by that truncation could read an
// empty file (seen once in CI 46031239493 under the parallel unit suite) — a fixture artifact, not a kernel behaviour.
const atomic = (f, text) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, text); fs.renameSync(t, f); };
const events = (id, oom, populated) => {
  atomic(path.join(cgDir(id), 'memory.events'), `low 0\nhigh 0\nmax ${oom}\noom ${oom}\noom_kill ${oom}\noom_group_kill 0\n`);
  atomic(path.join(cgDir(id), 'cgroup.events'), `populated ${populated}\nfrozen 0\n`);
};
const out = (s) => process.stdout.write(s);
const done = (code) => process.exit(code);

function processView(args) {
  const i = args.indexOf(IMAGE);
  const e = args.lastIndexOf('--entrypoint');
  const after = args.slice(i + 1);
  if (e >= 0 && e < i) return { Path: args[e + 1], Args: after };
  return { Path: after[0], Args: after.slice(1) };
}

const [cmd, ...rest] = argv;
if (cmd === 'version') { out('28.0.4\n'); done(0); }
if (cmd === 'image' && rest[0] === 'inspect') { out('{"Entrypoint":null,"Cmd":["sh"]}\n'); done(0); }
if (cmd === 'create') {
  const name = rest[rest.indexOf('--name') + 1];
  if (SCEN === 'reject-mount' && rest.includes('--mount')) { process.stderr.write('invalid mount config\n'); done(125); }
  const id = newId(name);
  fs.writeFileSync(file(name, 'create.json'), JSON.stringify(rest));
  fs.writeFileSync(path.join(DIR, `id-${id}`), name);
  writeState(name, { Status: 'created', Running: false, Pid: 0, ExitCode: 0, OOMKilled: false });
  fs.mkdirSync(cgDir(id), { recursive: true });
  fs.mkdirSync(path.join(process.env.FAKE_PROC_ROOT, String(PID)), { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_PROC_ROOT, String(PID), 'cgroup'), `0::/system.slice/docker-${id}.scope\n`);
  fs.writeFileSync(path.join(cgDir(id), 'cgroup.procs'), `${PID}\n`);
  events(id, SCEN === 'wrong-path' && rest.includes('--mount') ? 1 : 0, 1);
  out(`${id}\n`); done(0);
}
if (cmd === 'inspect') {
  const f = rest[rest.indexOf('-f') + 1];
  const name = nameOf(rest[rest.length - 1]);
  if (!fs.existsSync(file(name, 'state.json'))) { process.stderr.write('No such object\n'); done(1); }
  if (f.includes('.State')) { out(`${JSON.stringify(readState(name))}\n`); done(0); }
  if (f.includes('.Path')) {
    const v = processView(JSON.parse(fs.readFileSync(file(name, 'create.json'), 'utf8')));
    if (SCEN === 'wrong-path' && JSON.parse(fs.readFileSync(file(name, 'create.json'), 'utf8')).includes('--mount')) v.Path = '/bin/bash';
    out(`${JSON.stringify(v.Path)}\n${JSON.stringify(v.Args)}\n`); done(0);
  }
  if (f.includes('.Image')) { out('sha256:fake\n'); done(0); }
  if (f.includes('.Id')) { out(`${idOf(name)}\n`); done(0); }
  done(1);
}
if (cmd === 'start') {
  const name = rest[rest.length - 1];
  const id = idOf(name);
  const args = JSON.parse(fs.readFileSync(file(name, 'create.json'), 'utf8'));
  if (SCEN === 'no-start') { writeState(name, { Status: 'exited', Running: false, Pid: 0, ExitCode: 127, OOMKilled: false }); process.stderr.write('exec failed\n'); done(1); }
  writeState(name, { Status: 'running', Running: true, Pid: PID, ExitCode: 0, OOMKilled: false, StartPid: process.pid });
  const m = args.indexOf('--mount');
  if (m >= 0) {
    const src = /source=([^,]+)/.exec(args[m + 1])[1];
    const fd = fs.openSync(path.join(src, 'go'), 'r');
    let got = '';
    const b = Buffer.alloc(16);
    for (;;) { let n = 0; try { n = fs.readSync(fd, b, 0, 16, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; } if (!n) break; got += b.subarray(0, n).toString(); if (got.includes('\n')) break; }
    fs.closeSync(fd);
    fs.writeFileSync(file(name, 'gate.txt'), got);
    if (got !== 'go\n') { writeState(name, { Status: 'exited', Running: false, Pid: 0, ExitCode: 70, OOMKilled: false }); done(70); }
  }
  const input = rest.includes('-i') ? fs.readFileSync(0) : Buffer.alloc(0);
  fs.writeFileSync(file(name, 'stdin.bin'), input);
  if (SCEN === 'oom-missed' || SCEN === 'oom-at-once') events(id, 1, 1);
  process.stdout.write(input);
  events(id, SCEN.startsWith('oom') ? 1 : 0, 0);
  writeState(name, { Status: 'exited', Running: false, Pid: 0, ExitCode: 0, OOMKilled: false });
  done(0);
}
if (cmd === 'kill') {
  const name = nameOf(rest[rest.length - 1]);
  try { const st = readState(name); if (st.StartPid) { try { process.kill(st.StartPid, 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
  try { writeState(name, { Status: 'exited', Running: false, Pid: 0, ExitCode: 137, OOMKilled: false }); } catch { /* none */ }
  done(0);
}
if (cmd === 'wait' || cmd === 'rm' || cmd === 'ps') done(0);
done(0);
