// KAN-117 review 10620, slice B: deps-root-scripts-v1 — opt-in, pinned (base tree + package.json sha256 + exact
// script names) removal of ROOT lifecycle scripts from the disposable install manifest only. Real sh + git + jq on a
// temp repository; no Docker, no network, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const R = require('../../lib/research/root-scripts');
const SCRIPT = path.join(ROOT, 'sandbox/research/deps-root-scripts.sh');
const GIT_ENV = path.join(ROOT, 'sandbox/scripts/git-env.sh');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const haveTools = spawnSync('jq', ['--version']).status === 0 && spawnSync('git', ['--version']).status === 0;

const PKG = `${JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'mocha', prepare: 'husky install && npm run prepare:hooks', 'prepare:hooks': 'npx husky set .husky/commit-msg x' }, devDependencies: { mocha: '8.4.0' } }, null, 2)}\n`;
const LOCK = `${JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 2, requires: true, packages: { '': { name: 'x', version: '1.0.0', devDependencies: { mocha: '8.4.0' } } } }, null, 2)}\n`;

function fixture(pkg = PKG) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qbrs-'));
  const work = path.join(d, 'work'); const G = path.join(d, 'git'); const S = path.join(d, 'scratch');
  fs.mkdirSync(work); fs.mkdirSync(S); fs.mkdirSync(G);
  fs.writeFileSync(path.join(work, 'package.json'), pkg); fs.writeFileSync(path.join(work, 'package-lock.json'), LOCK);
  fs.writeFileSync(path.join(work, 'index.js'), 'module.exports = 1;\n');
  const g = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  g('init', '-q'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  execFileSync('git', ['clone', '-q', '--bare', work, path.join(G, 'repo')]);
  const head = execFileSync('git', ['--git-dir', path.join(G, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['--git-dir', path.join(G, 'repo'), 'update-ref', 'refs/qb/base', head]);
  const tree = execFileSync('git', ['--git-dir', path.join(G, 'repo'), 'rev-parse', 'refs/qb/base^{tree}'], { encoding: 'utf8' }).trim();
  return { d, G, S, tree, pkgSha: sha(pkg) };
}
function run(fx, allow) {
  const r = spawnSync('sh', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, QB_GIT: fx.G, QB_SCRATCH: fx.S, QB_GIT_ENV: GIT_ENV, QB_ROOT_SCRIPTS_ALLOW: JSON.stringify(allow) } });
  let plan = null; try { plan = JSON.parse(fs.readFileSync(path.join(fx.G, 'deps-plan.json'), 'utf8')); } catch { plan = null; }
  return { r, plan };
}
const entry = (fx, o = {}) => ({ key: 'axios-x', base_tree: fx.tree, package_json_sha256: fx.pkgSha, removed: ['prepare'], rule: 'deps-root-scripts-v1', ...o });

// ── allowlist ──
test('the committed allowlist validates: only the two reviewed axios bases, exact package.json hashes, prepare only', () => {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/mocha/root-scripts-allow.json'), 'utf8'));
  const entries = R.validateAllow(allow.entries);
  assert.deepEqual(entries.map((e) => e.key).sort(), ['axios-5892', 'axios-6539']);
  for (const e of entries) { assert.deepEqual(e.removed, ['prepare']); assert.match(e.base_tree, /^[0-9a-f]{40}$/); assert.match(e.package_json_sha256, /^[0-9a-f]{64}$/); }
  for (const bad of [
    [{ ...entries[0], base_tree: 'main' }], [{ ...entries[0], package_json_sha256: 'x' }], [{ ...entries[0], removed: [] }],
    [{ ...entries[0], removed: ['test'] }], [{ ...entries[0], rule: 'v2' }], [],
  ]) assert.throws(() => R.validateAllow(bad), /root scripts allow/);
});

test('deps-plan.sh (the product policy) is unchanged: root lifecycle scripts still block by default', () => {
  const s = fs.readFileSync(path.join(ROOT, 'sandbox/scripts/deps-plan.sh'), 'utf8');
  assert.match(s, /root lifecycle script\(s\): \$SCRIPTS/);
});

// ── the transform, for real (sh + git + jq) ──
test('a reviewed base: only the disposable install manifest loses the listed root script; original and transformed hashes recorded', { skip: !haveTools }, () => {
  const fx = fixture();
  const { r, plan } = run(fx, [entry(fx)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(plan.status, 'ready', JSON.stringify(plan));
  const inst = JSON.parse(fs.readFileSync(path.join(fx.S, 'package.json'), 'utf8'));
  assert.equal(inst.scripts.prepare, undefined, 'root prepare removed from the install copy');
  assert.equal(inst.scripts['prepare:hooks'], 'npx husky set .husky/commit-msg x', 'other scripts kept');
  assert.equal(inst.scripts.test, 'mocha');
  assert.deepEqual(inst.devDependencies, { mocha: '8.4.0' }, 'dependency graph untouched');
  assert.equal(fs.readFileSync(path.join(fx.S, 'package-lock.json'), 'utf8'), LOCK, 'lockfile byte-identical');
  assert.equal(plan.root_scripts.rule, 'deps-root-scripts-v1');
  assert.deepEqual(plan.root_scripts.removed, ['prepare']);
  assert.equal(plan.root_scripts.original_package_json_sha256, fx.pkgSha);
  assert.equal(plan.root_scripts.install_manifest_sha256, sha(fs.readFileSync(path.join(fx.S, 'package.json'))));
  assert.notEqual(plan.root_scripts.install_manifest_sha256, fx.pkgSha);
  // the base in git (what the agent and the grader get) still has the script
  const base = execFileSync('git', ['--git-dir', path.join(fx.G, 'repo'), 'show', 'refs/qb/base:package.json'], { encoding: 'utf8' });
  assert.equal(base, PKG);
  // the snapshot is of the TRANSFORMED install copy (deps-check compares against it after npm ci)
  const snap = fs.readFileSync(path.join(fx.G, 'deps-snapshot.txt'), 'utf8');
  assert.match(snap, new RegExp(`${plan.root_scripts.install_manifest_sha256}  \\./package\\.json`));
  // the manifest fingerprint is the BASE's (the same value deps-plan.sh records)
  assert.match(plan.manifest_fp, /^[0-9a-f]{64}$/);
});

test('unknown combinations still refuse: other tree, edited package.json, different script set', { skip: !haveTools }, () => {
  for (const [why, mk] of [
    ['other tree', (fx) => [entry(fx, { base_tree: 'a'.repeat(40) })]],
    ['other package.json', (fx) => [entry(fx, { package_json_sha256: 'b'.repeat(64) })]],
    ['different scripts', (fx) => [entry(fx, { removed: ['prepare', 'postinstall'] })]],
    ['empty allowlist', () => []],
  ]) {
    const fx = fixture();
    const { r, plan } = run(fx, mk(fx));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(plan.status, 'blocked', why);
    assert.equal(fs.readdirSync(fx.S).length, 0, `${why}: nothing written to the install copy`);
  }
});

test('a base with a script the entry does not name (postinstall) refuses even with a matching hash', { skip: !haveTools }, () => {
  const pkg = PKG.replace('"test": "mocha",', '"test": "mocha",\n    "postinstall": "node x.js",');
  const fx = fixture(pkg);
  const { plan } = run(fx, [entry(fx)]);
  assert.equal(plan.status, 'blocked');
});

// ── wiring: product default unchanged; the research option only after the product plan refused for root scripts ──
function fakeD(planSeq) {
  const calls = []; let i = 0;
  return {
    calls,
    runStage: async (name, args) => { calls.push({ name, args }); return { name, state: 'completed', exit_code: 0, stdout: '', stderr: '' }; },
    readPlan: async () => planSeq[Math.min(i++, planSeq.length - 1)],
  };
}
test('prepareDeps: without the research option a root-script block stays blocked; with it, the pinned transform runs once and only for that block', async () => {
  const S = require('../../lib/sandbox/stages');
  const WS = { runId: 'qb-t', image: 'tools-img', mount: (n, ro) => ['-v', `${n}${ro ? ':ro' : ''}`] };
  const blocked = { status: 'blocked', reason: 'setup_unsupported_project', detail: 'root lifecycle script(s): prepare' };
  let d = fakeD([blocked]);
  let r = await S.prepareDeps(WS, { seams: d });
  assert.equal(r.status, 'blocked'); assert.equal(d.calls.length, 1);
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/mocha/root-scripts-allow.json'), 'utf8')).entries;
  d = fakeD([blocked, { status: 'blocked', reason: 'setup_unsupported_project', detail: 'not in the reviewed allowlist' }]);
  r = await S.prepareDeps(WS, { seams: d, rootScripts: allow });
  assert.equal(r.status, 'blocked'); assert.equal(d.calls.length, 2);
  const t = d.calls[1];
  assert.ok(t.args.includes('--network') && t.args[t.args.indexOf('--network') + 1] === 'none');
  assert.ok(t.args.some((a) => a.startsWith('QB_ROOT_SCRIPTS_ALLOW=')));
  assert.ok(t.args.includes('tools-img'));
  const v1 = fakeD([{ status: 'blocked', reason: 'setup_unsupported_project', detail: 'lockfileVersion 1 (need 2 or 3)' }]);
  r = await S.prepareDeps(WS, { seams: v1, rootScripts: allow });
  assert.equal(r.status, 'blocked'); assert.equal(v1.calls.length, 1, 'other blockers never reach the transform');
});
