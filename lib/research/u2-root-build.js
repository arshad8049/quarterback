/**
 * lib/research/u2-root-build.js — KAN-114 10720 (U2): the narrowly specified pattern-B root-build allowlist
 * (bench/opus-pilot/u2/root-build-allow.json). Research callers only.
 *
 * Two halves per pinned base:
 *   install        the UNCHANGED, already-reviewed deps-root-scripts-v1 transform (root `prepare` removed from the
 *                  disposable install copy only). installEntries() yields exactly its entry shape.
 *   offline_build  ONE fixed argv (`npm run build`) run later in the no-network workspace, no credentials, with every
 *                  script npm will run for it (build, build:*, postbuild) sha256-pinned and no prebuild allowed.
 * QB's product deps policy (sandbox/scripts/deps-plan.sh) is not changed.
 */
const crypto = require('crypto');
const R = require('./root-scripts');

const RULE = 'root-build-patternB-v1';
const SCHEMA = 'qb-kan114-root-build-allow/1';
const BUILD_ARGV = Object.freeze(['npm', 'run', 'build']);
const MAX_TIMEOUT_S = 900;
/** Root scripts a pattern-B `prepare` chains that the allowlist NEVER runs (hooks, export checks, merge drivers). */
const NEVER_RUN = Object.freeze(['check-export-map', 'husky', 'npm-merge-driver-install', 'lint', 'test']);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isBuildScript = (k) => k === 'build' || k === 'postbuild' || k.startsWith('build:');

function validateRootBuildAllow(doc) {
  const bad = (m) => { throw new Error(`root build allow: ${m}`); };
  if (!doc || doc.schema !== SCHEMA) bad(`schema must be ${SCHEMA}`);
  const entries = doc.entries;
  if (!Array.isArray(entries) || !entries.length) bad('at least one reviewed entry is required');
  const keys = new Set();
  for (const e of entries) {
    if (!e || typeof e.key !== 'string' || !e.key || keys.has(e.key)) bad('key');
    keys.add(e.key);
    if (!/^[0-9a-f]{40}$/.test(e.base_commit || '')) bad(`${e.key}: base_commit`);
    if (!/^[0-9a-f]{40}$/.test(e.base_tree || '')) bad(`${e.key}: base_tree must be a full tree id`);
    if (!/^[0-9a-f]{64}$/.test(e.package_json_sha256 || '')) bad(`${e.key}: package_json_sha256`);
    if (!/^[0-9a-f]{64}$/.test(e.prepare_script_sha256 || '')) bad(`${e.key}: prepare_script_sha256`);
    const i = e.install || {};
    if (i.rule !== R.RULE || JSON.stringify(i.removed) !== JSON.stringify(['prepare'])) bad(`${e.key}: install must be ${R.RULE} removing exactly ["prepare"]`);
    const b = e.offline_build || {};
    if (b.rule !== RULE) bad(`${e.key}: offline_build.rule must be ${RULE}`);
    if (JSON.stringify(b.argv) !== JSON.stringify(BUILD_ARGV)) bad(`${e.key}: offline_build.argv must be exactly ${JSON.stringify(BUILD_ARGV)}`);
    if (b.network !== 'none') bad(`${e.key}: offline_build.network must be none`);
    if (b.credentials !== 'none') bad(`${e.key}: offline_build.credentials must be none`);
    if (b.tracked_changes_allowed !== false) bad(`${e.key}: offline_build.tracked_changes_allowed must be false`);
    if (!Number.isInteger(b.timeout_s) || b.timeout_s < 1 || b.timeout_s > MAX_TIMEOUT_S) bad(`${e.key}: offline_build.timeout_s must be 1..${MAX_TIMEOUT_S}`);
    const s = b.scripts_sha256 || {};
    const names = Object.keys(s);
    if (!names.includes('build') || !names.every(isBuildScript) || !names.every((k) => /^[0-9a-f]{64}$/.test(s[k]))) bad(`${e.key}: offline_build.scripts_sha256 must pin build (+ build:*, postbuild) only`);
  }
  R.validateAllow(installEntries({ entries }));
  return entries;
}

/** The deps-root-scripts-v1 entries (exact existing shape) for runSandboxed({ researchRootScripts }). */
function installEntries(doc) {
  return doc.entries.map((e) => ({ key: e.key, base_tree: e.base_tree, package_json_sha256: e.package_json_sha256, removed: [...e.install.removed], rule: e.install.rule }));
}

/** Problems ([] = ok) running the pinned build for `entry` against the base's package.json bytes. */
function pinnedBuildProblems(entry, packageJsonText) {
  const p = [];
  if (typeof packageJsonText !== 'string') return ['no package.json'];
  if (sha(packageJsonText) !== entry.package_json_sha256) p.push('package_json_sha256 differs from the reviewed base');
  let pkg;
  try { pkg = JSON.parse(packageJsonText); } catch { return [...p, 'package.json is not JSON']; }
  const scripts = (pkg && pkg.scripts) || {};
  if ('prebuild' in scripts) p.push('prebuild present (not in the reviewed script set)');
  const want = entry.offline_build.scripts_sha256;
  const have = Object.keys(scripts).filter(isBuildScript).sort();
  if (JSON.stringify(have) !== JSON.stringify(Object.keys(want).sort())) p.push(`build script set differs: ${JSON.stringify(have)}`);
  for (const k of Object.keys(want)) if (typeof scripts[k] !== 'string' || sha(scripts[k]) !== want[k]) p.push(`script ${k} differs from the reviewed pin`);
  if (JSON.stringify(entry.offline_build.argv) !== JSON.stringify(BUILD_ARGV)) p.push('argv is not the reviewed build argv');
  return p;
}

/** The exact build invocation: fixed argv, fixed npm environment, network none, no credentials. */
function offlineBuildPlan(entry) {
  return {
    argv: [...BUILD_ARGV],
    env: { npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'false' },
    network: 'none', credentials: 'none', timeout_s: entry.offline_build.timeout_s, never_run: [...NEVER_RUN],
  };
}

/** `git status --porcelain` (ignored files excluded) after the build must be empty. */
function treeStateProblems(porcelain) {
  if (typeof porcelain !== 'string') return ['no tree state recorded'];
  const p = [];
  const lines = porcelain.split('\n').filter(Boolean);
  if (lines.some((l) => !l.startsWith('??'))) p.push(`the build changed ${lines.filter((l) => !l.startsWith('??')).length} tracked file(s)`);
  if (lines.some((l) => l.startsWith('??'))) p.push(`the build left ${lines.filter((l) => l.startsWith('??')).length} untracked, non-ignored file(s)`);
  return p;
}

module.exports = { RULE, SCHEMA, BUILD_ARGV, NEVER_RUN, MAX_TIMEOUT_S, validateRootBuildAllow, installEntries, pinnedBuildProblems, offlineBuildPlan, treeStateProblems };
