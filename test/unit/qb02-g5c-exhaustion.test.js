/**
 * G5c exhaustion regression (KAN-118 review 10834): when Docker stays unavailable past
 * dockerDownMaxMs, the supervisor's retries are exhausted and it cannot confirm that nothing of
 * the run is running. It must then
 *   - record the infrastructure problem and explicit "enforcement unconfirmed" evidence,
 *   - commit NO terminal state (neither the CLI's outcome nor anything that reads as a completed
 *     cleanup), so the run stays open for recovery,
 *   - keep the obligation: the supervisor goes on retrying and, once Docker answers, kills and
 *     removes what is left before committing; if the supervisor is gone too, the reaper does it,
 * and every consumer (Supervision.propose, the pipeline's outcome, the reaper) must not read the
 * unresolved run as a success or as cleaned up.
 *
 * Fakes only (no Docker, no model): a stub Docker CLI whose availability is a marker file and which
 * models one residual RUNNING workload container per run (state files in a temp dir). Everything
 * else is the real code: the detached supervisor, Supervision, the pipeline's outcome function and
 * the reaper. dockerDownMaxMs = 0 makes exhaustion immediate, as in the review's reproduction.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-g5cx-docker-'));
const DOWN = path.join(stubDir, 'docker-is-down');
const LOG = path.join(stubDir, 'calls.log');
const STUB = path.join(stubDir, 'docker');
// POSIX sh only (CI runners have no zsh). Container "<run>-w" exists while <run>-w.exists is
// present and runs while <run>-w.running is present; kill stops it, rm -f removes it.
fs.writeFileSync(STUB, `#!/bin/sh
S='${stubDir}'
echo "$*" >> "$S/calls.log"
if [ -e "$S/docker-is-down" ]; then echo 'Cannot connect to the Docker daemon' >&2; exit 1; fi
run=''; for a in "$@"; do case "$a" in label=qb.run=*) run="\${a#label=qb.run=}";; esac; done
case "$1" in
  ps) case "$*" in
        *status=running*) [ -e "$S/$run-w.running" ] && echo "$run-w";;
        *) [ -e "$S/$run-w.exists" ] && echo "$run-w";;
      esac;;
  kill) shift; for c in "$@"; do rm -f "$S/$c.running"; done;;
  rm) shift; for c in "$@"; do [ "$c" = -f ] || rm -f "$S/$c.running" "$S/$c.exists"; done;;
esac
exit 0
`, { mode: 0o755 });
process.env.QB_DOCKER_BIN = STUB;                 // before any lib/sandbox module reads it
process.env.QB_SANDBOX_RENEW_MS = '300';
process.env.QB_SANDBOX_LEASE_TIMEOUT_MS = '1500';
process.env.QB_SANDBOX_KILL_GRACE_MS = '500';
process.env.QB_SANDBOX_READY_MS = '3000';
process.env.QB_SANDBOX_ACK_MS = '3000';
process.env.QB_SANDBOX_DOCKER_OP_MS = '1000';    // propose() waits at most 3 x this for a commit
process.env.QB_SANDBOX_DOCKER_DOWN_MAX_MS = '0';  // retries exhausted at the first failure

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../lib/sandbox/protocol');
const { Supervision } = require('../../lib/sandbox/lease');
const { reap } = require('../../lib/sandbox/reaper');
const { settleProposal } = require('../../lib/sandbox/pipeline');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const by = Date.now() + ms;
  while (Date.now() < by) { const v = await fn(); if (v) return v; await sleep(100); }
  return fn();
}
const residual = (id) => { fs.writeFileSync(path.join(stubDir, `${id}-w.exists`), ''); fs.writeFileSync(path.join(stubDir, `${id}-w.running`), ''); };
const isRunning = (id) => fs.existsSync(path.join(stubDir, `${id}-w.running`));
const exists = (id) => fs.existsSync(path.join(stubDir, `${id}-w.exists`));
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const events = (dir) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
const enforcement = (dir) => P.readJson(path.join(dir, 'enforcement.json'));

const roots = [];
const newRoot = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-g5cx-')); roots.push(r); return r; };
const sups = [];
after(() => {
  fs.rmSync(DOWN, { force: true });
  for (const id of sups) { try { process.kill(id.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

/** Assert the run is open and recorded as enforcement-unconfirmed, with nothing claimed. */
function assertUnresolved(dir, intended) {
  assert.equal(P.terminal(dir), null, `a terminal state was committed while enforcement is unconfirmed: ${JSON.stringify(P.terminal(dir))}`);
  const e = enforcement(dir);
  assert.ok(e, 'no enforcement record for the unresolved run');
  assert.equal(e.state, 'unresolved');
  assert.equal(e.unresolved, true);
  assert.match(e.reason, /^enforcement_unconfirmed: docker_unavailable/);
  assert.equal(e.stopped_confirmed, false);
  assert.equal(e.docker_unavailable, true);
  assert.equal(e.won_terminal, false);
  assert.equal(e.left, null, 'cleanup must not be represented as done');
  assert.deepEqual(e.intended, intended);
  assert.match(events(dir), /"enforcement_unconfirmed"/);
}

test('G5c exhaustion: a completed proposal while Docker stays down commits nothing; the pipeline reports infra_error; recovery kills and removes, then commits', async (t0) => {
  t0.after(() => fs.rmSync(DOWN, { force: true }));
  const root = newRoot();
  const id = `qbg5cx-p-${process.pid}`;
  const dir = path.join(root, id);
  const s = await Supervision.start(dir, id);
  sups.push(s.supervisor);
  await s.beginStage('agent', 60_000);
  residual(id);                                   // the workload is running ...
  fs.writeFileSync(DOWN, '');                     // ... when the daemon stops answering
  s.endStage('agent');
  const t = await s.propose('completed', 'fixture');

  assert.equal(t, null, `committed on retry exhaustion: ${JSON.stringify(P.terminal(dir))}`);
  await until(() => enforcement(dir), 5000);
  assertUnresolved(dir, { state: 'completed', reason: 'cli_proposal: fixture' });
  assert.ok(P.alive(s.supervisor), 'the supervisor keeps the obligation (it is still retrying)');

  // Consumer: the pipeline's outcome for this proposal is never the CLI's success.
  const out = settleProposal('completed', t, s.enforcement());
  assert.equal(out.state, 'infra_error');
  assert.match(out.reason, /^sandbox_enforcement_unconfirmed: enforcement_unconfirmed: docker_unavailable/);

  // Recovery: Docker returns; the residual workload is killed and removed before anything is committed.
  fs.rmSync(DOWN);
  const done = await until(() => P.terminal(dir), 15_000);
  assert.ok(done, 'no terminal state after Docker returned');
  assert.equal(isRunning(id), false, 'committed before the residual workload was killed');
  assert.match(calls(), new RegExp(`^kill ${id}-w$`, 'm'));
  assert.deepEqual([done.state, done.actor, done.reason], ['infra_error', 'supervisor', 'docker_unavailable (cli_proposal: fixture)']);
  // Removal follows the commit (G5b); the final enforcement record is written after it.
  const e = await until(() => (enforcement(dir) && enforcement(dir).stopped_confirmed ? enforcement(dir) : null), 10_000);
  assert.equal(exists(id), false, 'the residual workload was not removed');
  assert.equal(e.unresolved, undefined);
  assert.equal(e.won_terminal, true);
  assert.deepEqual(e.left, { containers: 0, networks: 0, volumes: 0 });
  assert.equal(await until(() => !P.alive(s.supervisor), 10_000), true, 'the supervisor exits after recovery');
});

test('G5c exhaustion: a stage deadline while Docker stays down commits no timeout either', async (t0) => {
  t0.after(() => fs.rmSync(DOWN, { force: true }));
  const root = newRoot();
  const id = `qbg5cx-d-${process.pid}`;
  const dir = path.join(root, id);
  const s = await Supervision.start(dir, id);
  sups.push(s.supervisor);
  await s.beginStage('agent', 500);
  residual(id);
  fs.writeFileSync(DOWN, '');
  await until(() => enforcement(dir), 10_000);
  assertUnresolved(dir, { state: 'timeout', reason: 'stage_deadline' });
  s.close();
  fs.rmSync(DOWN);
  const done = await until(() => P.terminal(dir), 15_000);
  assert.deepEqual(done && [done.state, done.reason], ['infra_error', 'docker_unavailable (stage_deadline)']);
  assert.equal(isRunning(id), false, 'committed before the residual workload was killed');
  const e = await until(() => (enforcement(dir) && enforcement(dir).stopped_confirmed ? enforcement(dir) : null), 10_000);
  assert.deepEqual(e.left, { containers: 0, networks: 0, volumes: 0 });
  assert.equal(exists(id), false);
  await until(() => !P.alive(s.supervisor), 10_000);
});

test('G5c exhaustion, supervisor gone too: the reaper claims nothing while Docker is down, then kills, removes and commits ABANDONED', async (t0) => {
  t0.after(() => fs.rmSync(DOWN, { force: true }));
  const root = newRoot();
  const id = `qbg5cx-r-${process.pid}`;
  const dir = path.join(root, id);
  const s = await Supervision.start(dir, id);
  sups.push(s.supervisor);
  await s.beginStage('agent', 60_000);
  residual(id);
  fs.writeFileSync(DOWN, '');
  s.endStage('agent');
  assert.equal(await s.propose('completed', 'fixture'), null);
  await until(() => enforcement(dir), 5000);
  assertUnresolved(dir, { state: 'completed', reason: 'cli_proposal: fixture' });

  // Both owners die (host fault / user kill): the CLI's identity is replaced by a dead one.
  process.kill(s.supervisor.pid, 'SIGKILL');
  assert.equal(await until(() => !P.alive(s.supervisor), 5000), true);
  const run = P.readJson(path.join(dir, 'run.json'));
  P.atomicWrite(path.join(dir, 'run.json'), { ...run, cli: { pid: 2 ** 22 + 7, start: 'gone' } });

  // Docker still down at the next start: nothing is claimed, the run stays open.
  const d1 = await reap(root);
  assert.deepEqual(d1.map((x) => [x.runId, x.decision]), [[id, 'unresolved']]);
  assert.equal(P.terminal(dir), null, `the reaper committed while Docker could not confirm: ${JSON.stringify(P.terminal(dir))}`);
  assert.equal(isRunning(id), true);

  // Docker back: the reaper kills and removes the residual workload, then commits ABANDONED.
  fs.rmSync(DOWN);
  const d2 = await reap(root);
  assert.deepEqual(d2.map((x) => [x.runId, x.decision]), [[id, 'reaped']]);
  assert.deepEqual(d2[0].left, { containers: 0, networks: 0, volumes: 0 });
  assert.equal(isRunning(id) || exists(id), false);
  const t = P.terminal(dir);
  assert.deepEqual([t.state, t.actor], ['ABANDONED', 'reaper']);
  assert.equal(t.enforcement_unconfirmed, true, 'the terminal record keeps the unresolved history');
});

test('G5c reaper: a run with dead owners and no terminal is not marked ABANDONED while Docker cannot confirm nothing runs', async (t0) => {
  t0.after(() => fs.rmSync(DOWN, { force: true }));
  const root = newRoot();
  const id = `qbg5cx-o-${process.pid}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  P.atomicWrite(path.join(dir, 'run.json'), { run_id: id, cli: { pid: 2 ** 22 + 8, start: 'gone' }, supervisor: { pid: 2 ** 22 + 9, start: 'gone' } });
  residual(id);
  fs.writeFileSync(DOWN, '');
  const d1 = await reap(root);
  assert.deepEqual(d1.map((x) => [x.runId, x.decision]), [[id, 'unresolved']]);
  assert.equal(P.terminal(dir), null, `ABANDONED claimed while Docker could not confirm: ${JSON.stringify(P.terminal(dir))}`);
  fs.rmSync(DOWN);
  const d2 = await reap(root);
  assert.deepEqual(d2.map((x) => [x.runId, x.decision]), [[id, 'reaped']]);
  assert.equal(isRunning(id) || exists(id), false);
  assert.deepEqual([P.terminal(dir).state, P.terminal(dir).reason], ['ABANDONED', 'owners_dead']);
});
