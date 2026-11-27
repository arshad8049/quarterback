#!/usr/bin/env node
/**
 * KAN-106 10838: held-out item tooling that is INDEPENDENT OF THE COMPILER UNDER TEST. Besides Node built-ins it
 * requires only lib/proc.js (the QB-01 subprocess wrapper: argv, shell:false); never intent/, verify/, context/ or any
 * model code (tested), so validating the controls can never run, consult or tune the compiler.
 *
 *   node bench/kan106-eval-v2/items.js validate ITEMS_DIR [--out FILE]   controls vs their hand-written reference tests
 *   node bench/kan106-eval-v2/items.js materialize ITEMS_DIR OUT_DIR      base/ only -> one-commit git repos; prints base SHAs
 *
 * Item layout (held-out/<ID>/): request.txt and spec.json (OWNER-authored; never written by the junior),
 * then base/, controls/<name>/, reference.test.js and item.json (junior-built from the spec, checked by the senior).
 * item.json uses the v1 scorer's fields: id, category, expected, requirements, control_expect, scope
 * {must_allow, must_protect}, scope_controls, refusal_evidence.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');

const GIT_ENV = { GIT_AUTHOR_NAME: 'QB Eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid', GIT_COMMITTER_NAME: 'QB Eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-26T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-26T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); } else fs.copyFileSync(s, d);
  }
}
const itemIds = (root) => fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

function runTests(dir, files) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = proc.run(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, timeout: 60_000 });
  const out = {};
  for (const m of String(r.stdout || '').matchAll(/^(not ok|ok) \d+ - (.+?)(?: #.*)?$/gm)) out[m[2]] = m[1] === 'ok' ? 'pass' : 'fail';
  return { status: r.status, results: out };
}

/** Every control under the hand-written reference test must match item.json control_expect; the base's own suite must pass. */
function validate(root) {
  const report = { _label: 'OFFLINE control validation, independent of QB (no compiler module, no model)', node: process.version, items: [] };
  let ok = true;
  for (const id of itemIds(root)) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'item.json'), 'utf8'));
    const entry = { id, expected: meta.expected, controls: {} };
    const own = fs.mkdtempSync(path.join(os.tmpdir(), `kan106-v2-${id}-`));
    try { copyTree(path.join(root, id, 'base'), own); entry.base_own_suite = runTests(own, []).status === 0 ? 'pass' : 'fail'; } finally { fs.rmSync(own, { recursive: true, force: true }); }
    if (entry.base_own_suite !== 'pass') ok = false;
    for (const control of Object.keys(meta.control_expect || {})) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kan106-v2-${id}-`));
      try {
        copyTree(path.join(root, id, 'base'), dir);
        if (control !== 'base') copyTree(path.join(root, id, 'controls', control), dir);
        fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
        fs.copyFileSync(path.join(root, id, 'reference.test.js'), path.join(dir, 'test', '__reference.test.js'));
        const got = runTests(dir, [path.join('test', '__reference.test.js')]).results;
        const want = meta.control_expect[control];
        const keys = Object.keys(want).sort();
        const match = keys.every((k) => got[k] === want[k]);
        entry.controls[control] = { results: got, matches_expectation: match };
        if (!match) ok = false;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    report.items.push(entry);
  }
  report.all_match = ok;
  return report;
}

/** Only base/ reaches the compiler: one deterministic commit per item. */
function materialize(root, out) {
  const shas = {};
  for (const id of itemIds(root)) {
    const dir = path.join(out, id);
    if (fs.existsSync(dir)) throw new Error(`${dir} exists: use a fresh OUT_DIR`);
    fs.mkdirSync(dir, { recursive: true });
    copyTree(path.join(root, id, 'base'), dir);
    const git = (...a) => {
      const r = proc.run('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr || r.error}`);
      return r.stdout.trim();
    };
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    shas[id] = git('rev-parse', 'HEAD');
  }
  return shas;
}

if (require.main === module) {
  const [cmd, a1, a2, ...rest] = process.argv.slice(2);
  if (cmd === 'validate' && a1) {
    const r = validate(path.resolve(a1)); const text = JSON.stringify(r, null, 2) + '\n';
    const i = [a2, ...rest].indexOf('--out'); if (i >= 0) fs.writeFileSync([a2, ...rest][i + 1], text); else process.stdout.write(text);
    process.exit(r.all_match ? 0 : 1);
  }
  if (cmd === 'materialize' && a1 && a2) { process.stdout.write(JSON.stringify(materialize(path.resolve(a1), path.resolve(a2)), null, 2) + '\n'); process.exit(0); }
  console.error('usage: items.js validate ITEMS_DIR [--out FILE] | materialize ITEMS_DIR OUT_DIR'); process.exit(2);
}
module.exports = { validate, materialize, itemIds };
