/**
 * lib/sandbox/live-restore.js — Docker's live-restore setting (KAN-44 10814; agent-sandbox.md G5c, §12).
 * With it, containers outlive a stopped daemon, so QB's termination bound does not hold. Read only: QB never changes
 * the owner's Docker configuration.
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

/** What the user must be told, or null. */
function warning(state) {
  if (state === 'disabled') return null;
  return `${state === 'enabled' ? 'Docker live-restore is enabled: containers can keep running while the Docker daemon is stopped' : 'QB could not read Docker\'s live-restore setting'}. `
    + 'Cleanup is tested only with live-restore disabled, so this host is not qualified for private code. QB does not change your Docker configuration.';
}

module.exports = { liveRestore, warning };
