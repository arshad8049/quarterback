/**
 * G5c regression (KAN-44 beta safety gate): a CLI proposal made while Docker does not answer
 * must not be committed until Docker confirms nothing of the run is running.
 *
 * Producer path: the CLI's `docker wait` fails because the daemon is gone, its inspect fails too,
 * and it proposes infra_error "container state unavailable" (test/helpers/sandbox-driver.js,
 * lib/sandbox/states.js). The supervisor used to commit any proposal on its next tick, before
 * killAll(), so a terminal state was claimed while enforcement could not be confirmed (the
 * integration G5c assertion seen failing on CI 42533377442, 45505323679, 45521454570).
 *
 * Runs the real detached supervisor and the real Supervision.propose() against a stub Docker CLI
 * whose availability is a marker file, so no Docker and no timing luck is needed: the old code
 * commits on the first 200 ms tick after the proposal; the test allows 3 s.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dockerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-g5c-docker-'));
const DOWN = path.join(dockerDir, 'docker-is-down');
const STUB = path.join(dockerDir, 'docker');
// An answering daemon with no containers, networks or volumes; while DOWN exists, every command fails
// the way a stopped daemon does.
fs.writeFileSync(STUB, `#!/bin/sh\nif [ -e '${DOWN}' ]; then echo 'Cannot connect to the Docker daemon' >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
process.env.QB_DOCKER_BIN = STUB;                 // before any lib/sandbox module reads it
process.env.QB_SANDBOX_RENEW_MS = '300';
process.env.QB_SANDBOX_LEASE_TIMEOUT_MS = '1500';
process.env.QB_SANDBOX_KILL_GRACE_MS = '500';
process.env.QB_SANDBOX_READY_MS = '3000';
process.env.QB_SANDBOX_ACK_MS = '3000';
process.env.QB_SANDBOX_DOCKER_OP_MS = '1000';    // propose() waits at most 3 × this for a commit
process.env.QB_SANDBOX_DOCKER_DOWN_MAX_MS = '30000';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../lib/sandbox/protocol');
const { Supervision } = require('../../lib/sandbox/lease');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const by = Date.now() + ms;
  while (Date.now() < by) { const v = fn(); if (v) return v; await sleep(100); }
  return fn();
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-g5c-'));
after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(dockerDir, { recursive: true, force: true });
});

test('G5c: a proposal made while Docker is unavailable is not committed until Docker confirms; then infra_error', async (t0) => {
  t0.after(() => fs.rmSync(DOWN, { force: true }));   // Docker "returns" even if an assertion failed
  const id = `qbg5c-${process.pid}`;
  const dir = path.join(root, id);
  const s = await Supervision.start(dir, id);
  await s.beginStage('agent', 60_000);
  fs.writeFileSync(DOWN, '');                     // the daemon stops: the CLI's wait and inspect fail
  s.endStage('agent');
  const proposed = await s.propose('infra_error', 'container state unavailable');
  const events = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.equal(proposed, null, `committed while Docker could not confirm enforcement: ${JSON.stringify(P.terminal(dir))}`);
  assert.equal(P.terminal(dir), null);
  assert.match(events(), /"docker_unavailable"/, 'the supervisor records that Docker is unavailable');
  assert.ok(P.alive(s.supervisor), 'the supervisor keeps retrying');

  fs.rmSync(DOWN);                                // Docker returns
  const t = await until(() => P.terminal(dir), 15_000);
  assert.ok(t, 'no terminal state after Docker returned');
  assert.equal(t.state, 'infra_error');
  assert.equal(t.actor, 'supervisor');
  assert.match(t.reason, /^docker_unavailable \(cli_proposal: container state unavailable\)$/);
  const e = await until(() => P.readJson(path.join(dir, 'enforcement.json')), 10_000);
  assert.equal(e.docker_unavailable, true);
  assert.equal(e.stopped_confirmed, true);
  assert.deepEqual(e.left, { containers: 0, networks: 0, volumes: 0 });
  assert.equal(await until(() => !P.alive(s.supervisor), 10_000), true, 'the supervisor exits after committing');
});

test('G5c control: with Docker answering, a proposal is committed as proposed (state unchanged)', async () => {
  const id = `qbg5c-up-${process.pid}`;
  const dir = path.join(root, id);
  const s = await Supervision.start(dir, id);
  await s.beginStage('agent', 60_000);
  s.endStage('agent');
  const t = await s.propose('completed', 'exit 0');
  assert.ok(t, 'no terminal state');
  assert.deepEqual([t.state, t.reason], ['completed', 'cli_proposal: exit 0']);
  assert.equal(await until(() => !P.alive(s.supervisor), 10_000), true);
});
