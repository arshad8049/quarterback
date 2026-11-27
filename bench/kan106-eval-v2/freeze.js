#!/usr/bin/env node
/**
 * KAN-106 10838: the two freezes of evaluation v2, in this order.
 *
 *   1. HARNESS FREEZE, before the junior sees any held-out spec. HARNESS-FREEZE.json holds the sha256 of
 *      every file of the compiler under test and of this harness (the lists below). Building the base
 *      repositories and controls afterwards cannot become tuning the compiler: the batch refuses if any of
 *      these files changed.
 *        node bench/kan106-eval-v2/freeze.js --check-harness
 *        node bench/kan106-eval-v2/freeze.js --write-harness [--source-rev SHA] [--note TEXT]   # ONLY in the harness-freeze commit
 *   2. PACKET FREEZE, before any model call: the complete held-out packet (every request, spec, base,
 *      control and reference test under held-out/), one manifest hash. The spec-only manifest (request.txt and
 *      spec.json per item) is what the owner posts first.
 *        node bench/kan106-eval-v2/freeze.js --packet DIR [--specs-only]
 *
 * Paths are walked on disk (not git), so an untracked file inside a frozen directory is a change too.
 * node_modules, .DS_Store and .env* are skipped (.env is refused separately by the batch).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const FREEZE_FILE = path.join(__dirname, 'HARNESS-FREEZE.json');
/** The compiler/QB code under test, and what the v2 scorer loads from v1. */
const COMPILER = ['qb.js', 'intent', 'verify', 'context', 'lib', 'sandbox/agent/qb-check-runner.mjs', 'bench/kan106-eval-v1/score.js', 'bench/kan106-eval-v1/FREEZE.json', 'package.json', 'package-lock.json'];
/** This harness (plan.json and the held-out packet are frozen separately, later). */
const HARNESS = ['bench/kan106-eval-v2/batch.js', 'bench/kan106-eval-v2/host-snapshot.js', 'bench/kan106-eval-v2/resource-gate.js',
  'bench/kan106-eval-v2/plan-check.js', 'bench/kan106-eval-v2/freeze.js', 'bench/kan106-eval-v2/gates.js', 'bench/kan106-eval-v2/score.js',
  'bench/kan106-eval-v2/items.js', 'bench/kan106-eval-v2/rescore-pinned.js', 'bench/kan106-eval-v2/run-batch.sh'];
const SKIP = (name) => name === 'node_modules' || name === '.DS_Store' || /^\.env/.test(name);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(abs, rel) {
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) return [rel];
  return fs.readdirSync(abs).filter((n) => !SKIP(n)).sort().flatMap((n) => walk(path.join(abs, n), path.posix.join(rel, n)));
}
function hashPaths(list, root = ROOT) {
  const files = {};
  for (const p of list) for (const f of walk(path.join(root, p), p)) files[f] = sha256(fs.readFileSync(path.join(root, f)));
  return files;
}
const manifestHash = (files) => sha256(Object.keys(files).sort().map((f) => `${files[f]}  ${f}\n`).join(''));

function currentHarness(root = ROOT) {
  const compiler = hashPaths(COMPILER, root); const harness = hashPaths(HARNESS, root);
  return { compiler, harness, compiler_manifest_sha256: manifestHash(compiler), harness_manifest_sha256: manifestHash(harness) };
}
function checkHarness({ root = ROOT, freezeFile = FREEZE_FILE } = {}) {
  let frozen;
  try { frozen = JSON.parse(fs.readFileSync(freezeFile, 'utf8')); } catch { return [`${path.relative(root, freezeFile)}: missing or not JSON (no harness freeze)`]; }
  const now = currentHarness(root);
  const problems = [];
  for (const part of ['compiler', 'harness']) {
    const want = frozen[part] || {};
    for (const [f, h] of Object.entries(want)) if (now[part][f] !== h) problems.push(`${part} ${f}: ${now[part][f] ? 'changed' : 'missing'}`);
    for (const f of Object.keys(now[part])) if (!(f in want)) problems.push(`${part} ${f}: not in the harness freeze`);
  }
  return problems;
}
function writeHarness({ root = ROOT, freezeFile = FREEZE_FILE, compilerSourceRev, note = null } = {}) {
  const now = currentHarness(root);
  const out = { format: 'qb-kan106-eval-v2-harness-freeze/1',
    _label: 'Harness freeze, made BEFORE the junior sees any held-out spec. The batch refuses if any listed file changes. Not a run authorization.',
    compiler_source_rev: compilerSourceRev || null, note, ...now };
  fs.writeFileSync(freezeFile, JSON.stringify(out, null, 2) + '\n');
  return out;
}

/** The held-out packet: every file under DIR (or only request.txt/spec.json per item), one manifest hash. */
function packet(dir, { specsOnly = false } = {}) {
  const all = walk(dir, '');
  const files = {};
  for (const f of all) {
    if (specsOnly && !/^[^/]+\/(request\.txt|spec\.json)$/.test(f)) continue;
    files[f] = sha256(fs.readFileSync(path.join(dir, f)));
  }
  return { files, manifest_sha256: manifestHash(files), count: Object.keys(files).length, specs_only: specsOnly };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--write-harness')) { const i = a.indexOf('--source-rev'); const j = a.indexOf('--note'); const r = writeHarness({ compilerSourceRev: i >= 0 ? a[i + 1] : null, note: j >= 0 ? a[j + 1] : null }); console.log(`✓ wrote HARNESS-FREEZE.json (compiler ${r.compiler_manifest_sha256}, harness ${r.harness_manifest_sha256})`); process.exit(0); }
  if (a.includes('--check-harness')) {
    const p = checkHarness();
    if (p.length) { console.error('✗ the harness freeze does not match:\n  ' + p.join('\n  ')); process.exit(1); }
    console.log('✓ compiler and harness match HARNESS-FREEZE.json'); process.exit(0);
  }
  const i = a.indexOf('--packet');
  if (i >= 0) { process.stdout.write(JSON.stringify(packet(path.resolve(a[i + 1]), { specsOnly: a.includes('--specs-only') }), null, 2) + '\n'); process.exit(0); }
  console.error('usage: freeze.js --check-harness | --write-harness [--source-rev SHA] | --packet DIR [--specs-only]'); process.exit(2);
}
module.exports = { checkHarness, writeHarness, currentHarness, packet, manifestHash, COMPILER, HARNESS, FREEZE_FILE };
