#!/usr/bin/env node
/**
 * KAN-106 10838: re-score a recorded batch with the scorer AND its dependencies exactly as they were at a pinned
 * revision. Offline, no model. The v1 scorer loads `contractState` from the checkout it runs in, so the same
 * records score differently once the validators change (at 2150ab6, KAN-107 10812 no longer finalizes the
 * recorded S2/S3/U2 contracts). The analysis is therefore defined as (records + scorer tree at its revision).
 *
 *   node bench/kan106-eval-v2/rescore-pinned.js --rev e5c460d --batch-dir docs/research/kan106/2026-11-19-eval-v1-881a51a \
 *        --out /tmp/rescore.json --expect docs/research/kan106/2026-11-19-eval-v1-881a51a/scores-freeze-v4.json
 *
 * The revision's tree is extracted with `git archive` into a temporary directory (this checkout's node_modules
 * are linked there, temporarily); the RECORDS come from --batch-dir in THIS checkout. Exit 0 on a byte-for-byte
 * match with --expect (or when --expect is absent), 1 on a mismatch, 2 when the revision is not available.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');

const ROOT = path.join(__dirname, '..', '..');
const DEP_DIRS = ['.', 'intent', 'agent', 'context', 'verify', 'memory', 'bench'];

const revAvailable = (rev, root = ROOT) => proc.run('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: root }).status === 0;

function rescorePinned({ rev, batchDir, out, expect = null, scorer = 'bench/kan106-eval-v1/score.js', root = ROOT }) {
  if (!revAvailable(rev, root)) return { status: 2, message: `revision ${rev} is not in this repository (fetch its source branch first)` };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-rescore-'));
  try {
    const tar = path.join(tmp, 'tree.tar');
    const a = proc.run('git', ['archive', '--format=tar', '-o', tar, rev], { cwd: root });
    if (a.status !== 0) return { status: 2, message: `git archive ${rev} failed: ${a.stderr}` };
    const tree = path.join(tmp, 'tree'); fs.mkdirSync(tree);
    const x = proc.run('tar', ['-xf', tar, '-C', tree]);
    if (x.status !== 0) return { status: 2, message: `tar failed: ${x.stderr}` };
    for (const d of DEP_DIRS) {
      const src = path.join(root, d, 'node_modules');
      if (fs.existsSync(src) && fs.existsSync(path.join(tree, d))) fs.symlinkSync(src, path.join(tree, d, 'node_modules'), 'dir');
    }
    const r = proc.run(process.execPath, [path.join(tree, scorer), '--batch-dir', path.resolve(batchDir), '--out', path.resolve(out)], { cwd: tree, timeout: 300_000 });
    if (r.status !== 0) return { status: 1, message: `scorer at ${rev} failed: ${r.stderr}` };
    if (!expect) return { status: 0, message: `scored at ${rev}` };
    const same = Buffer.compare(fs.readFileSync(out), fs.readFileSync(expect)) === 0;
    return { status: same ? 0 : 1, message: same ? `byte-for-byte identical to ${expect} (scored at ${rev})` : `differs from ${expect} (scored at ${rev})` };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  if (!opt('--rev') || !opt('--batch-dir') || !opt('--out')) { console.error('usage: rescore-pinned.js --rev SHA --batch-dir DIR --out FILE [--expect FILE] [--scorer PATH]'); process.exit(2); }
  const r = rescorePinned({ rev: opt('--rev'), batchDir: opt('--batch-dir'), out: opt('--out'), expect: opt('--expect'), scorer: opt('--scorer') || undefined });
  (r.status === 0 ? console.log : console.error)(`${r.status === 0 ? '✓' : '✗'} ${r.message}`);
  process.exit(r.status);
}
module.exports = { rescorePinned, revAvailable };
