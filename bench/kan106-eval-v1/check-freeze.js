#!/usr/bin/env node
/**
 * KAN-106 10758, eight-request evaluation v1: verify the frozen package before a run. Every file under items/
 * and every harness file listed in FREEZE.json must have its frozen sha256; with --base-shas FILE, the
 * materialized base commit SHAs must equal the frozen ones. Exit 0 when everything matches, 1 otherwise.
 *
 *   node bench/kan106-eval-v1/check-freeze.js [--base-shas FILE]
 *   node bench/kan106-eval-v1/check-freeze.js --write    # (re)compute FREEZE.json files: ONLY before the freeze commit
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const FREEZE = path.join(DIR, 'FREEZE.json');
const HARNESS = ['materialize.js', 'batch.js', 'score.js', 'validate-controls.js', 'check-freeze.js', 'run-batch.sh', 'rubric.md', 'offline-control-results.json'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function walk(d, rel = '') {
  return fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]));
}
function current() {
  const files = {};
  for (const f of walk(path.join(DIR, 'items'))) files[`items/${f}`] = sha(path.join(DIR, 'items', f));
  for (const f of HARNESS) files[f] = sha(path.join(DIR, f));
  return files;
}
function check({ baseShas } = {}) {
  const frozen = JSON.parse(fs.readFileSync(FREEZE, 'utf8'));
  const now = current();
  const problems = [];
  for (const [f, h] of Object.entries(frozen.files)) if (now[f] !== h) problems.push(`${f}: ${now[f] ? 'changed' : 'missing'}`);
  for (const f of Object.keys(now)) if (!(f in frozen.files)) problems.push(`${f}: not in the freeze`);
  if (baseShas) for (const [id, s] of Object.entries(frozen.base_shas)) if (baseShas[id] !== s) problems.push(`base ${id}: ${baseShas[id]} != frozen ${s}`);
  return problems;
}
if (require.main === module) {
  if (process.argv.includes('--write')) {
    const f = JSON.parse(fs.readFileSync(FREEZE, 'utf8'));
    f.files = current();
    fs.writeFileSync(FREEZE, JSON.stringify(f, null, 2) + '\n');
    process.exit(0);
  }
  const i = process.argv.indexOf('--base-shas');
  const problems = check({ baseShas: i > 0 ? JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) : null });
  if (problems.length) { console.error('✗ the frozen package does not match:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('✓ frozen package matches FREEZE.json');
}
module.exports = { check, current, HARNESS };
