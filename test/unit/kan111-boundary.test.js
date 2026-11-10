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
const run = (t, mode = 'tested') => spawnSync('bash', [HELPER, mode], { encoding: 'utf8', env: { ...process.env, QBX_ROOT: t.root, QBX_TMP: t.tmp } });

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
