#!/usr/bin/env node
/**
 * KAN-106 10758, eight-request evaluation v1: OFFLINE control validation. No model, no QB compiler.
 *
 * For every item with controls, overlay each control (base, correct, every wrong-*) on the item's base files
 * in a temporary directory, run the item's HAND-WRITTEN reference.test.js with node:test, and compare each
 * reference test's pass/fail with item.json control_expect. Also runs the base repository's own test suite on
 * the base (it must pass: the base is a working repository). Prints a JSON report; exit 1 on any mismatch.
 *
 *   node bench/kan106-eval-v1/validate-controls.js [--out FILE]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');

const ITEMS = path.join(__dirname, 'items');

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); } else fs.copyFileSync(s, d);
  }
}
/** A temp tree: base, overlaid with a control's files (if any). */
function tree(item, control) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kan106-eval-${item}-`));
  copyTree(path.join(ITEMS, item, 'base'), dir);
  if (control !== 'base') copyTree(path.join(ITEMS, item, 'controls', control), dir);
  return dir;
}
/** Run one test file; returns { name: 'pass'|'fail' } from the TAP output. */
function runTests(dir, files) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;   // a parent node:test run must not change the child's reporter
  const r = proc.run(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, timeout: 60_000 });
  const out = {};
  for (const m of r.stdout.matchAll(/^(not ok|ok) \d+ - (.+?)(?: #.*)?$/gm)) out[m[2]] = m[1] === 'ok' ? 'pass' : 'fail';
  return { status: r.status, results: out };
}

function validate() {
  const report = { _label: 'OFFLINE control validation (no model, no QB compiler): hand-written reference tests on each control', node: process.version, items: [] };
  let ok = true;
  for (const item of fs.readdirSync(ITEMS).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(ITEMS, item, 'item.json'), 'utf8'));
    const entry = { id: item, expected: meta.expected, controls: {} };
    const own = tree(item, 'base');
    try { entry.base_own_suite = runTests(own, []).status === 0 ? 'pass' : 'fail'; } finally { fs.rmSync(own, { recursive: true, force: true }); }
    if (entry.base_own_suite !== 'pass') ok = false;
    for (const control of Object.keys(meta.control_expect)) {
      const dir = tree(item, control);
      try {
        fs.copyFileSync(path.join(ITEMS, item, 'reference.test.js'), path.join(dir, 'test', '__reference.test.js'));
        const got = runTests(dir, [path.join('test', '__reference.test.js')]).results;
        const want = meta.control_expect[control];
        const match = JSON.stringify(Object.keys(want).sort().map((k) => [k, got[k]])) === JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]]));
        entry.controls[control] = { results: got, matches_expectation: match };
        if (!match) ok = false;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    report.items.push(entry);
  }
  report.all_match = ok;
  return report;
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const report = validate();
  const text = JSON.stringify(report, null, 2) + '\n';
  if (i > 0) fs.writeFileSync(process.argv[i + 1], text); else process.stdout.write(text);
  process.exit(report.all_match ? 0 : 1);
}
module.exports = { validate, ITEMS };
