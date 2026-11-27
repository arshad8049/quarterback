/**
 * lib/sandbox/gate.js — KAN-96: the trusted start gate, a control channel separate from the stage's stdin.
 *
 * The OOM observer must read its baseline BEFORE any task code runs, so a gated container starts in QB's own gate
 * script, which blocks on a FIFO until the host releases it and then `exec`s the stage's original command. The
 * stage's stdin (the agent's prompt, a patch, a check list) is never read by the gate: it reaches the command
 * byte for byte.
 *
 * Threat model. The task code is untrusted; the host, Docker, the image's /bin/sh and this script are trusted.
 *   - The channel is a per-stage host directory, created here (0755, owned by the host user), holding gate.sh and
 *     the FIFO `go` (0644: only the host user can write). It is bind-mounted READ-ONLY at /qb-gate into that one
 *     container and into no other, and removed when the stage ends.
 *   - Before release, nothing from the task runs in the container: only docker-init (--init) and the gate.
 *     So nothing untrusted can release the gate early, i.e. no task code can run before the observer is armed.
 *   - The host learns that the container is running from `docker inspect` (trusted), never from the container.
 *   - After release, the task can see /qb-gate (a script and a FIFO nobody reads any more); it cannot change it
 *     (read-only mount, and the FIFO is not writable by uid 10001). Writing to it would change nothing.
 *   - Evidence is never read from inside the container: the observer reads the container's own cgroup files on the
 *     host (oom-observer.js), which the container cannot write (no capabilities, read-only cgroup mount).
 *   - The gate refuses to run the command (exit 70) unless it read exactly "go": if the host dies or aborts before
 *     the release, the task never runs unobserved by accident.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../proc');

const GATE_MOUNT = '/qb-gate';
const GATE_SCRIPT_PATH = `${GATE_MOUNT}/gate.sh`;
const GATE_REFUSED_EXIT = 70;
const GATE_SCRIPT = [
  '#!/bin/sh',
  '# Quarterback trusted start gate (KAN-96). Waits for the host on a read-only FIFO, never on stdin,',
  '# then replaces itself with the stage command; stdin, arguments and environment are passed on unchanged.',
  `IFS= read -r qb_gate < ${GATE_MOUNT}/go || exit ${GATE_REFUSED_EXIT}`,
  `[ "$qb_gate" = go ] || exit ${GATE_REFUSED_EXIT}`,
  'unset qb_gate',
  'exec "$@"',
  '',
].join('\n');

const LIVE = new Set();
/** Gates still open (FIFO or script present) in this process (cleanup checks). */
const liveGates = () => LIVE.size;

// An emptied gate directory stays until its run's containers are removed: `docker cp` from a stopped container
// mounts its binds again and fails if a bind source is gone (CI 45933453765). Keyed by run id (qb.run label).
const DEFERRED = new Map();
const removeDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
function deferGateDir(runId, dir) {
  const k = runId || '';
  if (!DEFERRED.has(k)) DEFERRED.set(k, new Set());
  DEFERRED.get(k).add(dir);
}
/** Remove the gate directories of a run (call after its containers are removed). */
function removeGateDirs(runId) {
  const s = DEFERRED.get(runId || '');
  if (!s) return 0;
  for (const d of s) removeDir(d);
  DEFERRED.delete(runId || '');
  return s.size;
}
/** Gate directories kept for runs not yet removed. */
const pendingGateDirs = () => [...DEFERRED.values()].reduce((n, s) => n + s.size, 0);
process.on('exit', () => { for (const s of DEFERRED.values()) for (const d of s) removeDir(d); });

/**
 * Create one stage's gate. Throws when it cannot (the caller then runs the stage ungated, evidence unavailable).
 * @returns {{ dir, mountArgs: string[], release(): boolean, abort(): void, cleanup(): void, released: boolean }}
 */
function openGate({ tmpRoot = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'qb-gate-'));
  LIVE.add(dir);
  let fd = null;
  const g = { dir, released: false };
  /** Close the host end and remove the FIFO and script. With `keepFor` (a run id) the empty directory stays until
   * removeGateDirs(runId), because the stopped container still names it as a bind source; otherwise it goes now. */
  g.cleanup = ({ keepFor } = {}) => {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; }
    for (const f of ['go', 'gate.sh']) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* best effort */ } }
    if (keepFor !== undefined) deferGateDir(keepFor, dir); else removeDir(dir);
    LIVE.delete(dir);
  };
  try {
    if (/[,=\s]/.test(dir)) throw new Error(`temporary path not usable in --mount: ${dir}`);
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'gate.sh'), GATE_SCRIPT, { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'gate.sh'), 0o644);
    const fifo = path.join(dir, 'go');
    const mk = run('mkfifo', ['-m', '644', fifo], { timeout: 10_000 });
    if (mk.status !== 0) throw new Error(`mkfifo failed: ${String(mk.stderr || (mk.error && mk.error.message) || '').trim()}`);
    // Read-write and non-blocking: opening never waits for the container, and the gate's reader never blocks on open.
    fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  } catch (e) { g.cleanup(); throw e; }
  g.mountArgs = ['--mount', `type=bind,source=${dir},target=${GATE_MOUNT},readonly`];
  /**
   * Let the command run. Returns false if the gate could not be released (the command then never runs).
   * The host keeps its end open until cleanup: Docker reports "running" before the gate has opened the FIFO, and a
   * FIFO whose last open end closes drops its unread data.
   */
  g.release = () => {
    if (fd === null || g.released) return g.released;
    try { g.released = fs.writeSync(fd, 'go\n') === 3; } catch { g.released = false; }
    return g.released;
  };
  /** Never release: a gate already waiting reads end-of-file and exits 70; one not yet waiting must be killed. */
  g.abort = () => { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; } };
  return g;
}

module.exports = { openGate, liveGates, removeGateDirs, pendingGateDirs, GATE_MOUNT, GATE_SCRIPT, GATE_SCRIPT_PATH, GATE_REFUSED_EXIT };
