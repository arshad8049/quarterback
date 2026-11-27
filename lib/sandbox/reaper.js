/**
 * lib/sandbox/reaper.js — next-start recovery (agent-sandbox.md §8.3, G5b).
 *
 * For each sandbox run directory without a terminal state: if both the CLI and
 * the supervisor are gone (pid + start time, so a reused pid does not count),
 * kill the run's containers and, once Docker confirms none is running, commit
 * ABANDONED and remove its resources. If Docker does not answer (or a container
 * keeps running) nothing is committed: decision "unresolved", retried at the next
 * start (G5c). A run the supervisor left "unresolved" (enforcement.json) is handled
 * the same way; its ABANDONED record carries enforcement_unconfirmed: true. Runs whose
 * owners are alive are left alone. Runs that already have a terminal state get
 * their resources removed if any were left behind.
 */

const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const D = require('./docker');

async function reap(sandboxRoot) {
  if (!fs.existsSync(sandboxRoot)) return [];
  const decisions = [];
  for (const runId of fs.readdirSync(sandboxRoot)) {
    const runDir = path.join(sandboxRoot, runId);
    const run = P.readJson(path.join(runDir, 'run.json'));
    if (!run) continue;
    if (P.terminal(runDir)) {
      const left = await D.removeRun(runId);
      decisions.push({ runId, decision: 'terminal_exists', left });
      continue;
    }
    if (P.alive(run.cli) || P.alive(run.supervisor)) {
      decisions.push({ runId, decision: 'owner_alive' });
      continue;
    }
    // G5c: "Docker did not answer" is not "nothing running". Commit ABANDONED only after Docker
    // confirms no container of the run is running; otherwise leave the run open for the next start.
    let running = null;
    for (let i = 0; i < 5; i++) {
      running = await D.listContainers(runId, { running: true });
      if (running === null || !running.length) break;
      await D.op(['kill', ...running]);
    }
    if (running !== null && running.length) running = await D.listContainers(runId, { running: true });
    if (running === null || running.length) {
      P.event(runDir, 'reaper', 'unresolved', { docker_unavailable: running === null, running: running && running.length });
      decisions.push({ runId, decision: 'unresolved', docker_unavailable: running === null });
      continue;
    }
    const e = P.readJson(path.join(runDir, 'enforcement.json'));
    const won = P.commitTerminal(runDir, 'ABANDONED', 'reaper', 'owners_dead',
      e && e.unresolved ? { enforcement_unconfirmed: true } : {});
    const left = await D.removeRun(runId);
    P.event(runDir, 'reaper', 'reaped', { won, left });
    decisions.push({ runId, decision: 'reaped', won, left });
  }
  return decisions;
}

module.exports = { reap };
