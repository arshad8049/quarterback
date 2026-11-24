/**
 * lib/credential-scan.js — copied-credential detection in a captured patch (KAN-44, senior 10814; agent-sandbox.md §5.4).
 *
 * Reads the exact patch bytes and reports KINDS, counts and file names, never a value. It changes nothing: the patch
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

/** @returns {{ schema, patch_sha256, status: 'clean'|'finding', findings: [{ kind, count, file }], unscanned, limits }} */
function scanPatch(buf, { exact = [] } = {}) {
  const found = new Map();
  const add = (kind, file) => { const k = `${kind}\0${file ?? ''}`; const f = found.get(k) || { kind, count: 0, file: file ?? null }; f.count++; found.set(k, f); };
  for (const v of exact) {
    if (typeof v !== 'string' || v.length < MIN_EXACT) continue;
    if (buf.includes(Buffer.from(v))) add('run_credential', null);
  }
  let file = null; let minus = 0; let plus = 0; let binary = 0;
  for (const line of buf.toString('latin1').split('\n')) {
    if (minus > 0 || plus > 0) {   // inside a hunk: git says how many lines it has
      const c = line[0];
      if (c === '-' && minus > 0) { minus--; continue; }
      if (c === ' ' && minus > 0 && plus > 0) { minus--; plus--; continue; }
      if (c === '\\') { for (const k of matches(line)) add(k, file); continue; }
      if (c === '+' && plus > 0) { plus--; for (const k of matches(line)) add(k, file); continue; }
      minus = plus = 0;   // not what the header promised: scan it, and everything after it, as ordinary text
    }
    const h = HUNK.exec(line);
    if (h) { minus = h[1] === undefined ? 1 : Number(h[1]); plus = h[2] === undefined ? 1 : Number(h[2]); }
    const kinds = matches(line);
    const name = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (name) file = matches(name[1]).length ? '(a file name that itself matches)' : name[1];
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) binary++;
    for (const k of kinds) add(k, name ? '(file name)' : file);
  }
  const findings = [...found.values()];
  return { schema: 'qb-credential-scan/1', patch_sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    status: findings.length ? 'finding' : 'clean', findings, unscanned: { binary_files: binary }, limits: LIMITS };
}

const describeFindings = (findings) => findings.map((f) => `${f.kind === 'run_credential' ? "this run's own credential" : `a value in a known credential format (${f.kind})`}${f.file ? ` in ${f.file}` : ''}`);

module.exports = { scanPatch, describeFindings, FORMATS, LIMITS };
