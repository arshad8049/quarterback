// KAN-110 review (comment 10539): static audit for Proposal A (a Jest runner + Yarn installs).
// Every dependency restriction is checked INDEPENDENTLY. deps-plan.sh stops at its first problem,
// so for a Yarn-only project (no package-lock.json) it never checked workspaces, root lifecycle
// scripts or git/file/link dependencies. This module never runs Yarn, Yarn plugins, yarnPath
// binaries or any repository code: it parses text.
//
// Result vocabulary:
//   blockers      a restriction Proposal A does not lift → the task is incompatible
//   unknowns      something a static read cannot settle → the task is unknown
//   requirements  something the adapter itself must do explicitly (e.g. map the yarnpkg mirror)
//   conditions    caveats on every "eligible_static" task (runtime is never proven statically)

import crypto from 'node:crypto';

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const NPM = 'registry.npmjs.org';
const YARN_MIRROR = 'registry.yarnpkg.com';
const LOCAL_OR_GIT_SPEC = /^(file:|link:|portal:|git:|git\+|github:|gitlab:|bitbucket:|https?:\/\/[^#]*\.git(#.*)?$|[\w.-]+\/[\w.-]+(#.*)?$)/;

/** Which Yarn lockfile generation this is. */
export function yarnGeneration(text) {
  if (typeof text !== 'string') return { generation: null };
  if (/^<{7}|^={7}|^>{7}/m.test(text)) return { generation: null };
  if (/^# yarn lockfile v1\s*$/m.test(text)) return { generation: 'classic' };
  const m = /^__metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:\s*(\d+)/m.exec(text);
  if (m) return { generation: 'berry', metadata_version: Number(m[1]) };
  return { generation: null };
}

/** Parse lockfile entries into { key, version, resolved, integrity } (classic) or resolution/checksum (berry). */
export function yarnEntries(text, generation) {
  const out = [];
  const blocks = text.split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    if (!lines.length || /^\s/.test(lines[0]) || lines[0].startsWith('__metadata')) continue;
    const key = lines[0].replace(/:$/, '');
    const field = (name) => { const l = lines.find((x) => new RegExp(`^\\s+${name}[: ]`).test(x)); return l ? l.replace(new RegExp(`^\\s+${name}:?\\s*`), '').replace(/^"|"$/g, '') : null; };
    if (generation === 'classic') out.push({ key, version: field('version'), resolved: field('resolved'), integrity: field('integrity') });
    else out.push({ key, version: field('version'), resolution: field('resolution'), checksum: field('checksum'), linkType: field('linkType') });
  }
  return out;
}

function lifecycle(pkg) { return Object.keys((pkg && pkg.scripts) || {}).filter((k) => LIFECYCLE.includes(k)); }
function manifestLocalOrGit(pkg) {
  const specs = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}), ...(pkg?.optionalDependencies || {}) };
  return Object.entries(specs).filter(([, v]) => typeof v === 'string' && LOCAL_OR_GIT_SPEC.test(v)).map(([k]) => k);
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return null; } }
function registryVerdict(hosts, b, req) {
  for (const h of hosts) { if (h === YARN_MIRROR) req.add('yarn:registry-mapping'); else if (h !== NPM) b.add('deps:non-npm-registry'); }
}
const yamlKey = (y, k) => { const m = new RegExp(`^${k}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm').exec(y || ''); return m ? m[1].trim() : null; };
const rcKey = (rc, k) => { const m = new RegExp(`^\\s*"?${k}"?\\s+"?([^"\\n]+)"?\\s*$`, 'm').exec(rc || ''); return m ? m[1].trim() : null; };

/**
 * Audit a Yarn project. `installScripts` (optional) is { required: [...], optional: [...] } from an
 * external source (e.g. npm registry metadata), because yarn.lock does not record install scripts.
 */
export function auditYarn({ pkg, lockText, yarnrc = null, yarnrcYml = null, rootFiles = new Set(), installScripts = null }) {
  const b = new Set(); const u = new Set(); const req = new Set();
  const a = { kind: 'yarn', generation: null, metadata_version: null, lock_sha256: null, config: {}, workspaces: false, resolutions: false, registries: [], protocols: {}, integrity: null, lifecycle_root: [], install_scripts: installScripts };
  if (pkg?.workspaces) { a.workspaces = true; b.add('deps:workspaces'); }
  a.lifecycle_root = lifecycle(pkg); if (a.lifecycle_root.length) b.add('deps:lifecycle-scripts');
  if (manifestLocalOrGit(pkg).length) b.add('deps:git-or-file-deps');
  a.resolutions = !!pkg?.resolutions;
  // Configuration (never executed)
  a.config = {
    yarnrc: !!yarnrc, yarnrc_yml: !!yarnrcYml, packageManager: typeof pkg?.packageManager === 'string' ? pkg.packageManager : null,
    yarn_path: yamlKey(yarnrcYml, 'yarnPath') || rcKey(yarnrc, 'yarn-path'),
    plugins: /^plugins:/m.test(yarnrcYml || ''),
    node_linker: yamlKey(yarnrcYml, 'nodeLinker'),
    registry: yamlKey(yarnrcYml, 'npmRegistryServer') || rcKey(yarnrc, 'registry'),
  };
  if (a.config.yarn_path || a.config.plugins) b.add('yarn:repo-supplied-binary-or-plugins');
  if (lockText == null) { b.add('yarn:missing-lockfile'); return finish(a, b, u, req); }
  a.lock_sha256 = crypto.createHash('sha256').update(lockText).digest('hex');
  const g = yarnGeneration(lockText);
  a.generation = g.generation; a.metadata_version = g.metadata_version ?? null;
  if (!g.generation) { u.add('yarn:unreadable-lockfile'); return finish(a, b, u, req); }
  const entries = yarnEntries(lockText, g.generation);
  const hosts = new Set();
  if (a.config.registry) hosts.add(hostOf(a.config.registry.replace(/\/?$/, '/')) || a.config.registry);
  let missing = 0; let counted = 0; let sha1Only = 0;
  for (const e of entries) {
    if (g.generation === 'classic') {
      const r = e.resolved || '';
      const proto = /^https?:/.test(r) ? (/\.git(#|$)/.test(r) || /^https?:\/\/(codeload\.github\.com|github\.com|gitlab\.com|bitbucket\.org)\//.test(r) ? 'git' : 'registry') : (r.split(':')[0] || 'none');
      a.protocols[proto] = (a.protocols[proto] || 0) + 1;
      if (proto !== 'registry') { if (proto !== 'none') b.add('deps:git-or-file-deps'); continue; }
      hosts.add(hostOf(r)); counted++;
      if (!e.integrity) { if (/#[0-9a-f]{40}$/.test(r)) sha1Only++; else missing++; }
    } else {
      const res = e.resolution || ''; const proto = (/@([a-z+]+):/.exec(res) || [])[1] || 'unknown';
      a.protocols[proto] = (a.protocols[proto] || 0) + 1;
      if (proto === 'workspace') { if (!/@workspace:\.$/.test(res)) b.add('deps:workspaces'); continue; }
      if (['file', 'link', 'portal', 'git', 'git+https', 'git+ssh', 'github', 'https', 'http'].includes(proto)) { b.add('deps:git-or-file-deps'); continue; }
      if (proto === 'patch') { b.add('yarn:patch-protocol'); continue; }
      counted++; if (!e.checksum) missing++;
    }
  }
  if (g.generation === 'berry') {
    if (!a.config.registry) hosts.add(YARN_MIRROR); // Berry's default registry
    if (a.config.node_linker !== 'node-modules') b.add('yarn:pnp-linker'); // default is Plug'n'Play: no node_modules
  }
  a.integrity = { entries: counted, missing, sha1_only: sha1Only };
  if (missing) b.add('yarn:missing-integrity');
  if (sha1Only) req.add('yarn:sha1-only-integrity'); // yarn classic verifies the sha1 fragment; weaker than sha512
  a.registries = [...hosts].filter(Boolean);
  registryVerdict(a.registries, b, req);
  return finish(a, b, u, req);
}

/** Audit an npm project: every deps-plan.sh restriction, independently, plus install scripts and registries. */
export function auditNpm({ pkg, lock }) {
  const b = new Set(); const u = new Set(); const req = new Set();
  const a = { kind: 'npm', lockfile_version: lock ? Number(lock.lockfileVersion || 0) : null, workspaces: !!pkg?.workspaces, lifecycle_root: lifecycle(pkg), registries: [], integrity: null, install_scripts: null };
  if (!lock) b.add('deps:missing-lockfile');
  else if (a.lockfile_version !== 2 && a.lockfile_version !== 3) b.add('deps:npm-lockfile-v1');
  if (a.workspaces) b.add('deps:workspaces');
  if (a.lifecycle_root.length) b.add('deps:lifecycle-scripts');
  if (manifestLocalOrGit(pkg).length) b.add('deps:git-or-file-deps');
  if (lock && lock.packages) {
    const hosts = new Set(); let counted = 0, missing = 0; const req1 = [], opt = [];
    for (const [k, v] of Object.entries(lock.packages)) {
      if (!k || !v) continue;
      if (v.link === true || /^(file:|git|github:|link:)/.test(v.resolved || '')) { b.add('deps:git-or-file-deps'); continue; }
      if (v.resolved) { hosts.add(hostOf(v.resolved)); counted++; if (!v.integrity) missing++; }
      if (v.hasInstallScript) (v.optional ? opt : req1).push(k.replace(/^.*node_modules\//, ''));
    }
    a.registries = [...hosts].filter(Boolean); registryVerdict(a.registries, b, req);
    a.integrity = { entries: counted, missing }; if (missing) b.add('deps:missing-integrity');
    a.install_scripts = { required: [...new Set(req1)].sort(), optional: [...new Set(opt)].sort() };
  } else if (lock) u.add('deps:lockfile-v1-unaudited');
  return finish(a, b, u, req);
}

function finish(a, b, u, req) { a.blockers = [...b].sort(); a.unknowns = [...u].sort(); a.requirements = [...req].sort(); return a; }

/** Node major pinned by the environment (setup image / nvm, .nvmrc, .node-version). Engines is a range, not a pin. */
export function pinnedMajor(n = {}) {
  for (const v of [n.image_or_setup, n.nvmrc, n.node_version_file]) { const m = /(\d+)/.exec(v || ''); if (m) return Number(m[1]); }
  return null;
}

/** Does a package.json engines.node range admit Node <major>.x? Major-level semver, '||' alternatives. Unparseable → true (not a blocker). */
export function rangeAdmits(range, major) {
  const v = [major, 0, 0];
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const ver = (s) => { const p = s.replace(/^v/, '').split('.'); return [0, 1, 2].map((i) => (p[i] === undefined || /x|\*/i.test(p[i]) ? null : Number(p[i]))); };
  const ok = (part) => {
    const toks = part.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').replace(/\s*-\s*/, ' - ').split(/\s+/).filter(Boolean);
    if (!toks.length || toks.includes('*')) return true;
    if (toks.length === 3 && toks[1] === '-') return ok(`>=${toks[0]} <=${toks[2]}`);
    return toks.every((t) => {
      const m = /^(>=|<=|>|<|=|\^|~)?\s*(v?[\dx*]+(?:\.[\dx*]+){0,2})/.exec(t); if (!m) return true;
      const op = m[1] || ''; const raw = ver(m[2]); const lo = raw.map((x) => (x == null ? 0 : x));
      if (op === '' || op === '=' ) { if (raw[1] == null) return v[0] === lo[0]; if (raw[2] == null) return v[0] === lo[0] && v[1] === lo[1]; return cmp(v, lo) === 0; }
      if (op === '^') return v[0] === lo[0] && cmp(v, lo) >= 0;
      if (op === '~') return v[0] === lo[0] && (raw[1] == null || v[1] === lo[1]) && cmp(v, lo) >= 0;
      if (op === '>=') return cmp(v, lo) >= 0;
      if (op === '>') return raw[1] == null ? v[0] > lo[0] : cmp(v, lo) > 0;
      if (op === '<') return cmp(v, lo) < 0;
      if (op === '<=') return raw[1] == null ? v[0] <= lo[0] : cmp(v, lo) <= 0;
      return true;
    });
  };
  return String(range).split('||').some(ok);
}

/**
 * Proposal A classification for one task.
 * t = { runner_frameworks, grader_evidence, services, node, deps } where deps is auditYarn/auditNpm output.
 * opts.yarn = Yarn generations the adapter would support (e.g. ['classic']).
 */
export function proposalA(t, opts = { yarn: ['classic'] }) {
  const b = new Set(t.deps.blockers); const u = new Set(t.deps.unknowns); const req = new Set(t.deps.requirements);
  const runners = new Set(t.runner_frameworks || []);
  if (!runners.size) u.add('runner:unidentified');
  for (const r of runners) if (r !== 'jest') b.add(`runner:${r}`);
  if (t.deps.kind === 'yarn' && t.deps.generation && !opts.yarn.includes(t.deps.generation)) b.add(`yarn:unsupported-generation:${t.deps.generation}`);
  (t.services || []).forEach((s) => b.add(`service:${s}`));
  const n = t.node || {};
  const pin = pinnedMajor(n);
  if (n.engines && !rangeAdmits(n.engines, 24)) b.add('runtime:engines-exclude-node24');
  if (pin != null && pin < 20) u.add(`runtime:pinned-node${pin}`); // a hint, not execution proof
  if (pin == null && !n.engines) u.add('runtime:undeclared');
  if (t.grader_evidence !== 'present') u.add('grader:evidence-missing');
  const is = t.deps.install_scripts;
  if (is == null) u.add('install:dependency-scripts-unrecorded');
  else if (is.required.length) u.add(`install:native-or-script-deps:${is.required.join(',')}`);
  const blockers = [...b].sort(); const unknowns = [...u].sort();
  return { status: blockers.length ? 'incompatible' : unknowns.length ? 'unknown' : 'eligible_static', blockers, unknowns, requirements: [...req].sort(), conditions: ['runtime:unverified'] };
}
