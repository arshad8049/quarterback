#!/usr/bin/env node
/**
 * KAN-106 10758, eight-request evaluation v1: materialize each item's base/ as a one-commit git repository
 * with a fixed identity and date, so its commit SHA is deterministic and frozen in FREEZE.json.
 * Only base/ is copied: controls, reference tests and item.json never reach the compiler's repository.
 *
 *   node bench/kan106-eval-v1/materialize.js OUT_DIR     # prints { "<item>": "<base sha>" }
 */
const fs = require('fs');
const path = require('path');
const proc = require('../../lib/proc');

const ITEMS = path.join(__dirname, 'items');
const ENV = { GIT_AUTHOR_NAME: 'QB Eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid', GIT_COMMITTER_NAME: 'QB Eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-19T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-19T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); } else fs.copyFileSync(s, d);
  }
}
function materialize(out) {
  const shas = {};
  for (const id of fs.readdirSync(ITEMS).sort()) {
    const dir = path.join(out, id);
    if (fs.existsSync(dir)) throw new Error(`${dir} exists: use a fresh OUT_DIR`);
    fs.mkdirSync(dir, { recursive: true });
    copyTree(path.join(ITEMS, id, 'base'), dir);
    const git = (...a) => {
      const r = proc.run('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: { ...process.env, ...ENV } });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr || r.error}`);
      return r.stdout.trim();
    };
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    shas[id] = git('rev-parse', 'HEAD');
  }
  return shas;
}
if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: materialize.js OUT_DIR'); process.exit(2); }
  process.stdout.write(JSON.stringify(materialize(path.resolve(process.argv[2])), null, 2) + '\n');
}
module.exports = { materialize };
