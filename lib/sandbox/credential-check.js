/**
 * lib/sandbox/credential-check.js — is the run's OWN credential in the captured patch? (KAN-44 10814, §5.4)
 *
 * Mode K: QB's process already holds the variable; the bytes are compared here.
 * Mode S: QB's Node process never reads the credential. A trusted container (no network, read-only, no capabilities)
 *   gets the patch on stdin and compares it with the stored login and with the run's copy (the agent can overwrite the
 *   copy, so the stored login decides too). Only the word FOUND or ABSENT comes back; anything else is an error.
 * An error is never "absent": `qb patch` repeats the check and refuses if it still fails.
 */
const D = require('./docker');
const { scanPatch } = require('../credential-scan');

// grep exit 1 is "no match"; 2 is an error. Only strings long enough to be a secret are compared.
const SCRIPT = `set -eu
umask 077
cat > /tmp/p
: > /tmp/k
q='.claudeAiOauth | (.accessToken, .refreshToken) | strings | select(length >= 16)'
[ -f /stored/.credentials.json ] || exit 3
jq -r "$q" /stored/.credentials.json > /tmp/k
[ -s /tmp/k ] || exit 3
# the agent owns the run copy and may have broken it: it can add values to search for, never remove the stored ones
if [ -f /run-copy/.credentials.json ]; then jq -r "$q" /run-copy/.credentials.json >> /tmp/k 2>/dev/null || :; fi
rc=0; grep -aFq -f /tmp/k /tmp/p || rc=$?
case $rc in 0) echo FOUND ;; 1) echo ABSENT ;; *) exit 4 ;; esac`;

/** Mode S comparison. @returns {'found'|'absent'|'error'} */
async function exactModeS(buf, { image, runId = null, authVolume, op = D.op, labels = [] }) {
  try {
    const r = await op(['run', '--rm', '-i', ...labels, '--user', '10001:10001', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m',
      '-v', `${authVolume}:/stored:ro`, ...(runId ? ['-v', `${runId}-cred:/run-copy:ro`] : []),
      '--entrypoint', 'sh', image, '-c', SCRIPT], { input: buf, timeoutMs: 60_000, maxBytes: 4096 });
    if (!r.ok) return 'error';
    return r.stdout === 'FOUND\n' ? 'found' : r.stdout === 'ABSENT\n' ? 'absent' : 'error';
  } catch { return 'error'; }
}

/** The full scan evidence for a captured patch; holds no credential value. */
async function checkCaptured(buf, { cred, ws, authVolume, op, env = process.env } = {}) {
  let exact = { mode: 'none', status: 'not_applicable' };
  const values = [];
  if (cred && cred.mode === 'K') {
    const v = env[cred.variable];
    if (v) values.push(v);
    exact = { mode: 'K', status: v ? (buf.includes(Buffer.from(v)) ? 'found' : 'absent') : 'error' };
  } else if (cred && cred.mode === 'S') {
    exact = { mode: 'S', status: await exactModeS(buf, { image: ws.image, runId: ws.runId, authVolume, ...(op ? { op } : {}), labels: D.runLabels(ws.runId, 'credential-check') }) };
  }
  const scan = scanPatch(buf, { exact: values });
  if (exact.status === 'found' && !scan.findings.some((f) => f.kind === 'run_credential')) scan.findings.unshift({ kind: 'run_credential', count: 1, file: null });
  return { ...scan, status: scan.findings.length ? 'finding' : 'clean', exact };
}

module.exports = { checkCaptured, exactModeS };
