/**
 * lib/credential-scan.js — copied-credential detection in a captured patch (KAN-44, senior 10814; agent-sandbox.md §5.4).
 *
 * Reads the exact patch bytes and reports KINDS, counts and opaque file NUMBERS (the n-th file of the patch), never a
 * value and never a file name: a name is untrusted text the agent chose and can itself be a credential (10837 B1). It changes nothing: the patch
 * stays the authoritative bytes. Two searches:
 *   - exact values the caller may hold (Mode K): anywhere in the bytes;
 *   - known formats: added lines, file names, headers and anything that is not clearly a removed or context line of a
 *     hunk (those lines are the user's own content, not something the agent copied in).
 * Not found: encoded, encrypted, split, reversed or otherwise transformed values; unknown formats; the content of git
 * binary patches (counted in `unscanned`). A clean result is therefore not proof.
 */
const crypto = require('crypto');

const FORMATS = [
  ['anthropic_key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['openai_style_key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['npm_token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['aws_access_key_id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['resend_key', /\bre_[A-Za-z0-9]{16,}\b/],
  ['private_key_block', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
];
const MIN_EXACT = 16;   // a shorter "credential" would match ordinary text
const LIMITS = [
  'a clean result is not proof that no credential was copied',
  'encoded, encrypted, split or otherwise transformed values and unknown formats are not found',
  'the content of binary files is not scanned',
  'only the captured patch is scanned: logs and other local evidence remain sensitive',
];
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const matches = (text) => FORMATS.filter(([, re]) => re.test(text)).map(([k]) => k);

/** @returns {{ schema, patch_sha256, status: 'clean'|'finding', findings: [{ kind, count, file_index, where }], unscanned, limits }}
 *  file_index: 1-based position of the file in the patch (null: before any file, or the exact search, which is global);
 *  where: 'name' (the diff --git line), 'header' (other lines outside a hunk), 'content' (hunk lines), null (exact). */
function scanPatch(buf, { exact = [] } = {}) {
  const found = new Map();
  const add = (kind, fileIndex, where) => {
    const k = `${kind}\0${fileIndex ?? ''}\0${where ?? ''}`;
    const f = found.get(k) || { kind, count: 0, file_index: fileIndex ?? null, where: where ?? null };
    f.count++; found.set(k, f);
  };
  for (const v of exact) {
    if (typeof v !== 'string' || v.length < MIN_EXACT) continue;
    if (buf.includes(Buffer.from(v))) add('run_credential', null, null);
  }
  let file = null; let n = 0; let minus = 0; let plus = 0; let binary = 0;
  for (const line of buf.toString('latin1').split('\n')) {
    if (minus > 0 || plus > 0) {   // inside a hunk: git says how many lines it has
      const c = line[0];
      if (c === '-' && minus > 0) { minus--; continue; }
      if (c === ' ' && minus > 0 && plus > 0) { minus--; plus--; continue; }
      if (c === '\\') { for (const k of matches(line)) add(k, file, 'content'); continue; }
      if (c === '+' && plus > 0) { plus--; for (const k of matches(line)) add(k, file, 'content'); continue; }
      minus = plus = 0;   // not what the header promised: scan it, and everything after it, as ordinary text
    }
    const h = HUNK.exec(line);
    if (h) { minus = h[1] === undefined ? 1 : Number(h[1]); plus = h[2] === undefined ? 1 : Number(h[2]); }
    const isName = /^diff --git /.test(line);
    if (isName) file = ++n;
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) binary++;
    for (const k of matches(line)) add(k, file, isName ? 'name' : 'header');
  }
  const findings = [...found.values()];
  return { schema: 'qb-credential-scan/2', patch_sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    status: findings.length ? 'finding' : 'clean', findings, unscanned: { binary_files: binary }, limits: LIMITS };
}

const WHERE = { name: 'the name of', header: 'a header of', content: '' };
/** Human text for findings: kinds and file numbers only (names are never shown). */
const describeFindings = (findings) => findings.map((f) => {
  const what = f.kind === 'run_credential' ? "this run's own credential" : `a value in a known credential format (${f.kind})`;
  if (!Number.isInteger(f.file_index)) return what;
  return `${what} in ${WHERE[f.where] ? `${WHERE[f.where]} ` : ''}file ${f.file_index} of the patch`;
});

/**
 * 10837 B2: the captured patch is on hold unless its credential scan is present and clean. A hold means: no diff or
 * file content to any model judge, no further coding attempt, no file names in output or memory, and `qb patch`
 * refuses. Null when there is no scan (nothing was captured) or it is clean.
 */
function securityHold(execution) {
  const scan = execution && execution.sandbox && execution.sandbox.credential_scan;
  if (!scan || scan.status === 'clean') return null;
  return scan;
}

/** KAN-44 10846 (2): the exact-check result without its binding (salt and fingerprints stay in the scan evidence only). */
function publicExact(exact) {
  if (!exact) return null;
  const { binding, ...rest } = exact;
  return { ...rest, ...(binding ? { bound: true } : {}) };
}

/** KAN-44 10846 (4): the extra summary lines for a held result; empty without a hold. */
function resultLines(report) {
  const h = report && report.security_hold;
  if (!h) return [];
  return [`RESULT is UNRESOLVED because of a security hold (${h.status === 'finding' ? 'the patch appears to contain a credential' : 'the credential check could not finish'}): export denied.`,
    'Individual test results are kept in the run record as evidence; they are not an overall result.'];
}

/** What qb.js prints for a hold (no value, no name). */
function holdMessage(scan) {
  const lines = [];
  if (scan.status === 'finding') {
    lines.push('✗ The captured patch appears to contain a credential. `qb patch` will refuse to export it, and QB makes no further attempt.');
    for (const d of new Set(describeFindings(scan.findings || []))) lines.push(`    - ${d}`);
    lines.push('  If it is real, revoke or rotate it now. The local run record is sensitive.');
  } else {
    lines.push('✗ QB could not finish the credential check of the captured patch, so the patch is treated as unsafe.');
    lines.push('  The diff was not sent to any model judge, QB makes no further attempt, and `qb patch` will refuse to export it.');
    lines.push('  Check that Docker is running and you are still signed in, then run the task again. The local run record is sensitive.');
  }
  return lines;
}

/** The changed-file listing qb.js prints: names only when the scan is clean or absent. */
function changeListing(execution) {
  const changes = (execution && execution.changes) || [];
  if (securityHold(execution)) return changes.length ? [`${changes.length} file(s) changed; names withheld (credential hold; see the run record, which is sensitive)`] : [];
  return changes.map((c) => `${c.file.padEnd(38)} +${c.additions} -${c.deletions}`);
}

module.exports = { scanPatch, describeFindings, securityHold, publicExact, resultLines, holdMessage, changeListing, FORMATS, LIMITS };
