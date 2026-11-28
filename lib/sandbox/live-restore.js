/**
 * lib/sandbox/live-restore.js — Docker's live-restore setting (KAN-44 10814, 10837 A; agent-sandbox.md G5c, §12).
 * With it, containers outlive a stopped daemon, so QB's termination bound does not hold. Read only: QB never changes
 * the owner's Docker configuration.
 *
 * Enforced in the shared sandbox entry (pipeline.js runSandboxed), before anything is created: enabled or unreadable
 * is BLOCKED for every caller. This is a check at the start of each run only: if the daemon is reconfigured or
 * restarted with live-restore while a run is in progress, the gate does not notice.
 */
const D = require('./docker');

/** @returns {Promise<'enabled'|'disabled'|'unknown'>} bounded; anything unreadable is 'unknown', never 'disabled' */
async function liveRestore({ op = D.op } = {}) {
  try {
    const r = await op(['info', '--format', '{{json .LiveRestoreEnabled}}'], { timeoutMs: 10_000 });
    const v = r.ok ? r.stdout.trim() : '';
    return v === 'true' ? 'enabled' : v === 'false' ? 'disabled' : 'unknown';
  } catch { return 'unknown'; }
}

const NOT_CHANGED = 'QB does not change your Docker configuration.';

/** What the user must be told, or null. */
function warning(state) {
  if (state === 'disabled') return null;
  return `${state === 'enabled' ? 'Docker live-restore is enabled: containers can keep running while the Docker daemon is stopped' : 'QB could not read Docker\'s live-restore setting'}. `
    + `Cleanup is tested only with live-restore disabled, so QB will not start a sandboxed run on this host. ${NOT_CHANGED}`;
}

/** The BLOCKED reason for a state, or null when the run may start. Unknown is never allowed. */
function blockedReason(state) {
  if (state === 'disabled') return null;
  const code = state === 'enabled' ? 'live_restore_enabled' : 'live_restore_unknown';
  const fix = state === 'enabled' ? 'set "live-restore": false in Docker\'s daemon.json yourself and restart Docker'
    : 'check that `docker info` works and shows LiveRestoreEnabled false';
  return `${code}: ${warning(state)} To run: ${fix}; \`qb doctor\` checks it.`;
}

module.exports = { liveRestore, warning, blockedReason };
