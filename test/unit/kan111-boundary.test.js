/**
 * KAN-111 review 10554: the test-boundary instrumentation (qbx-boundary.sh) must fail closed. These run the
 * real helper (a short local shell script) against temporary directories via QBX_ROOT; no Docker, no network.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, '..', '..', 'bench', 'public', 'grader', 'immutable-offline-v1', 'qbx-boundary.sh');
const kv = (t, k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(t) || [])[1];
function tree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qbxb-')); const root = path.join(d, 'testbed'); const tmp = path.join(d, 'tmp');
  fs.mkdirSync(path.join(root, '__tests__'), { recursive: true }); fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(root, '__tests__', 'Range.ts'), 'test\n'); fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'x\n'); fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref\n');
  return { d, root, tmp };
}
const run = (t, mode = 'tested', env = {}) => spawnSync('bash', [HELPER, mode], { encoding: 'utf8', env: { ...process.env, QBX_ROOT: t.root, QBX_TMP: t.tmp, ...env } });
// Review 10557: a shim placed first on PATH makes one tool fail deterministically (no permissions tricks needed)
function shim(t, name, body) {
  const bin = path.join(t.d, 'shim-bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
// A failed run must print no evidence values and leave no finished manifest behind
function assertFailedClosed(t, r, mode = 'tested') {
  assert.notEqual(r.status, 0, 'must fail: ' + r.stdout);
  assert.doesNotMatch(r.stdout, /QBX_[A-Z]+_(SHA256|FILES|MARKER_COUNT|NODE_MODULES_SHA256)=/, 'no evidence values on failure');
  assert.equal(fs.existsSync(path.join(t.tmp, `qbx-${mode}.txt`)), false, 'no finished manifest on failure');
}
const REAL_FIND = spawnSync('bash', ['-c', 'command -v find'], { encoding: 'utf8' }).stdout.trim();

describe('KAN-111 qbx-boundary.sh (fails closed)', () => {
  test('writes a complete manifest whose hash, file count and node_modules digest are printed', () => {
    const t = tree(); const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    const man = fs.readFileSync(path.join(t.tmp, 'qbx-tested.txt'), 'utf8');
    assert.equal(kv(r.stdout, 'QBX_TESTED_SHA256'), crypto.createHash('sha256').update(man).digest('hex'));
    assert.equal(Number(kv(r.stdout, 'QBX_TESTED_FILES')), 2, 'two files outside .git and node_modules');
    assert.match(kv(r.stdout, 'QBX_TESTED_NODE_MODULES_SHA256'), /^[0-9a-f]{64}$/);
    assert.match(man, /__tests__\/Range\.ts/); assert.doesNotMatch(man, /node_modules|\.git\//);
    fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('the node_modules digest changes when node_modules changes', () => {
    const t = tree(); const a = kv(run(t).stdout, 'QBX_TESTED_NODE_MODULES_SHA256');
    fs.writeFileSync(path.join(t.root, 'node_modules', 'x', 'i.js'), 'changed\n');
    assert.notEqual(kv(run(t).stdout, 'QBX_TESTED_NODE_MODULES_SHA256'), a);
    fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('symlinks are recorded with their target, not silently omitted', () => {
    const t = tree(); fs.symlinkSync('../src/a.js', path.join(t.root, '__tests__', 'link.js'));
    const r = run(t); assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(t.tmp, 'qbx-tested.txt'), 'utf8'), /symlink .*__tests__\/link\.js -> \.\.\/src\/a\.js/);
    fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('a missing root fails (non-zero), never a silent success', () => {
    const t = tree(); fs.rmSync(t.root, { recursive: true, force: true });
    assert.notEqual(run(t).status, 0); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('an unreadable file fails the manifest (non-zero)', { skip: process.getuid && process.getuid() === 0 && 'root can read everything' }, () => {
    const t = tree(); const f = path.join(t.root, 'src', 'a.js'); fs.chmodSync(f, 0o000);
    assert.notEqual(run(t).status, 0);
    fs.chmodSync(f, 0o644); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('an unknown mode is refused', () => {
    const t = tree(); assert.notEqual(run(t, 'bogus').status, 0); fs.rmSync(t.d, { recursive: true, force: true });
  });
});

describe('KAN-111 qbx-boundary.sh: enumeration and read errors (review 10557)', () => {
  test('a file enumeration that fails part-way (find exits non-zero after partial output) fails closed', () => {
    const t = tree();
    const r = run(t, 'tested', shim(t, 'find', `case "$PWD" in */node_modules) exec "${REAL_FIND}" "$@";; esac; "${REAL_FIND}" "$@"; echo "find: simulated permission denied" >&2; exit 1`));
    assertFailedClosed(t, r); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('an unreadable directory (real enumeration failure) fails closed', { skip: process.getuid && process.getuid() === 0 && 'root can read everything' }, () => {
    const t = tree(); const dir = path.join(t.root, 'src', 'locked'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'h.js'), 'h\n'); fs.chmodSync(dir, 0o000);
    const r = run(t); fs.chmodSync(dir, 0o755);
    assertFailedClosed(t, r); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('a marker-count read error (grep exit 2) fails closed instead of counting as "no marker"', () => {
    const t = tree();
    const r = run(t, 'tested', shim(t, 'grep', 'echo "grep: simulated read error" >&2; exit 2'));
    assertFailedClosed(t, r); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('no marker (grep exit 1) is a count of 0, and markers are counted when present', () => {
    const t = tree(); assert.equal(kv(run(t).stdout, 'QBX_TESTED_MARKER_COUNT'), '0');
    fs.appendFileSync(path.join(t.root, '__tests__', 'Range.ts'), '// KAN-111 tamper marker\n');
    assert.equal(kv(run(t).stdout, 'QBX_TESTED_MARKER_COUNT'), '1'); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('a node_modules enumeration failure fails closed', () => {
    const t = tree();
    // Fail only the node_modules walk: the shim delegates every other call to the real find
    const r = run(t, 'tested', shim(t, 'find', `case "$PWD" in */node_modules) "${REAL_FIND}" "$@"; exit 1;; esac; exec "${REAL_FIND}" "$@"`));
    assertFailedClosed(t, r); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('a path containing a newline is refused (the manifest is line-oriented)', () => {
    const t = tree(); fs.writeFileSync(path.join(t.root, 'src', 'bad\nname.js'), 'x\n');
    assertFailedClosed(t, run(t)); fs.rmSync(t.d, { recursive: true, force: true });
  });
  test('the printed FILES equals the parsed entry count; every entry is well formed and unique', () => {
    const t = tree(); fs.symlinkSync('../src/a.js', path.join(t.root, '__tests__', 'link.js'));
    const r = run(t); assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(path.join(t.tmp, 'qbx-tested.txt'), 'utf8').split('\n').filter(Boolean);
    assert.equal(Number(kv(r.stdout, 'QBX_TESTED_FILES')), lines.length);
    const paths = lines.map((l) => { const m = /^(?:[0-9a-f]{64}  |symlink )\.\/(.+?)(?: -> .*)?$/.exec(l); assert.ok(m, 'malformed: ' + l); return m[1]; });
    assert.equal(new Set(paths).size, paths.length, 'duplicate paths');
    fs.rmSync(t.d, { recursive: true, force: true });
  });
});
