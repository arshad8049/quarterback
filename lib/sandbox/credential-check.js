/**
 * lib/sandbox/credential-check.js — is the run's OWN credential in the captured patch? (KAN-44 10814, 10837 B; §5.4)
 *
 * Mode K: QB's process already holds the variable; the bytes are compared here.
 * Mode S: QB's Node process never reads the credential. A trusted container (no network, read-only, no capabilities)
 *   gets the patch on stdin and compares it with the stored login and with the run's copy (the agent can overwrite the
 *   copy, so the stored login decides too). Only a word comes back (FOUND, ABSENT, UNBOUND); anything else is an error.
 * An error is never "absent": the scan is then INCOMPLETE, which holds the patch like a finding (10837 B2).
 *
 * Binding (10837 B3): when the run is given its credential, QB records a salted SHA-256 fingerprint of each value
 * (random 16-byte salt per run; the values are high-entropy tokens, so the fingerprint does not reveal them). A later
 * recheck may clear a failed check only if the credential it compares against has exactly those fingerprints, i.e.
 * it is demonstrably the same credential. A refreshed, replaced or removed credential is UNBOUND: export stays refused.
 *
 * The comparison container is named and labelled (qb.run, qb.role=credential-check) and always removed: after an
 * answer, a timeout, a cancellation (signal) or a failure.
 */
const crypto = require('crypto');
const D = require('./docker');
const { scanPatch } = require('../credential-scan');

const BINDING_SCHEMA = 'qb-credential-binding/1';
const fingerprint = (salt, value) => crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{32}$/;

// The values compared and fingerprinted: the OAuth tokens, only strings long enough to be a secret.
const JQ = '.claudeAiOauth | (.accessToken, .refreshToken) | strings | select(length >= 16)';

// grep exit 1 is "no match"; 2 is an error. With QB_FP_EXPECT (a recheck), every expected fingerprint must be one of
// the stored login's values, or the answer is UNBOUND and nothing is compared.
const SCRIPT = `set -eu
umask 077
cat > /tmp/p
: > /tmp/k
q='${JQ}'
[ -f /stored/.credentials.json ] || exit 3
jq -r "$q" /stored/.credentials.json > /tmp/k
[ -s /tmp/k ] || exit 3
if [ -n "\${QB_FP_EXPECT:-}" ]; then
  : > /tmp/f
  while IFS= read -r v; do printf '%s:%s' "$QB_FP_SALT" "$v" | sha256sum | cut -c1-64 >> /tmp/f; done < /tmp/k
  for e in $QB_FP_EXPECT; do grep -qxF "$e" /tmp/f || { echo UNBOUND; exit 0; }; done
fi
# the agent owns the run copy and may have broken it: it can add values to search for, never remove the stored ones
if [ -f /run-copy/.credentials.json ]; then jq -r "$q" /run-copy/.credentials.json >> /tmp/k 2>/dev/null || :; fi
rc=0; grep -aFq -f /tmp/k /tmp/p || rc=$?
case $rc in 0) echo FOUND ;; 1) echo ABSENT ;; *) exit 4 ;; esac`;

/** Fingerprints of a copied Mode S credential, printed by the copy container (see auth.js). */
const FINGERPRINT_SCRIPT = `q='${JQ}'; jq -r "$q" "$1" | while IFS= read -r v; do printf '%s:%s' "$QB_FP_SALT" "$v" | sha256sum | cut -c1-64; done`;

/** A binding from the copy container's output, or null when it is not exactly 1..4 fingerprints. */
function parseBinding(stdout, salt) {
  const lines = String(stdout || '').split('\n').filter(Boolean);
  if (!SALT.test(salt) || !lines.length || lines.length > 4 || !lines.every((l) => HEX64.test(l))) return null;
  return { schema: BINDING_SCHEMA, mode: 'S', salt, fingerprints: lines };
}

/** A Mode K binding for the value in `variable`. */
function bindingK(variable, value) {
  const salt = newSalt();
  return { schema: BINDING_SCHEMA, mode: 'K', variable, salt, fingerprints: [fingerprint(salt, value)] };
}

const validBinding = (b, mode) => Boolean(b && b.schema === BINDING_SCHEMA && b.mode === mode && SALT.test(b.salt)
  && Array.isArray(b.fingerprints) && b.fingerprints.length && b.fingerprints.every((f) => HEX64.test(f)));

/**
 * Mode S comparison. `expect` (a binding): recheck against the stored login only, and only if it is the same credential.
 * @returns {Promise<'found'|'absent'|'unbound'|'error'>}
 */
async function exactModeS(buf, { image, runId = null, authVolume, op = D.op, labels = null, expect = null, signal = null, timeoutMs = 60_000 }) {
  const owner = runId || `qb-patch-${crypto.randomBytes(4).toString('hex')}`;
  const name = `${owner}-credcheck-${crypto.randomBytes(4).toString('hex')}`;
  const lbl = labels || D.runLabels(owner, 'credential-check');
  const remove = () => Promise.resolve().then(() => op(['rm', '-f', name])).catch(() => null);
  let onAbort = null;
  try {
    if (signal && signal.aborted) return 'error';
    const c = await op(['create', '--name', name, '-i', ...lbl,
      '--user', '10001:10001', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m',
      ...(expect ? ['-e', `QB_FP_SALT=${expect.salt}`, '-e', `QB_FP_EXPECT=${expect.fingerprints.join(' ')}`] : []),
      '-v', `${authVolume}:/stored:ro`, ...(runId && !expect ? ['-v', `${runId}-cred:/run-copy:ro`] : []),
      '--entrypoint', 'sh', image, '-c', SCRIPT]);
    if (!c || !c.ok) return 'error';
    if (signal) { onAbort = () => { remove(); }; signal.addEventListener('abort', onAbort, { once: true }); }
    const r = await op(['start', '-a', '-i', name], { input: buf, timeoutMs, maxBytes: 4096 });
    if (!r.ok || r.timedOut || (signal && signal.aborted)) return 'error';
    if (r.stdout === 'FOUND\n') return 'found';
    if (r.stdout === 'ABSENT\n') return 'absent';
    if (expect && r.stdout === 'UNBOUND\n') return 'unbound';
    return 'error';
  } catch { return 'error'; } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    await remove();
  }
}

/** The full scan evidence for a captured patch; holds no credential value and no file name. */
async function checkCaptured(buf, { cred, ws, authVolume, op, env = process.env, signal = null } = {}) {
  let exact = { mode: 'none', status: 'not_applicable' };
  const values = [];
  if (cred && cred.mode === 'K') {
    const v = env[cred.variable];
    if (v) values.push(v);
    exact = { mode: 'K', status: v ? (buf.includes(Buffer.from(v)) ? 'found' : 'absent') : 'error' };
  } else if (cred && cred.mode === 'S') {
    exact = { mode: 'S', status: await exactModeS(buf, { image: ws.image, runId: ws.runId, authVolume, ...(op ? { op } : {}), signal, labels: D.runLabels(ws.runId, 'credential-check') }) };
  }
  if (cred && cred.binding) exact.binding = cred.binding;
  const scan = scanPatch(buf, { exact: values });
  if (exact.status === 'found' && !scan.findings.some((f) => f.kind === 'run_credential')) scan.findings.unshift({ kind: 'run_credential', count: 1, file_index: null, where: null });
  // 10837 B2: a check that could not be completed is never clean.
  const status = scan.findings.length ? 'finding' : exact.status === 'error' ? 'incomplete' : 'clean';
  return { ...scan, status, exact };
}

module.exports = { checkCaptured, exactModeS, fingerprint, newSalt, parseBinding, bindingK, validBinding, FINGERPRINT_SCRIPT, BINDING_SCHEMA };
