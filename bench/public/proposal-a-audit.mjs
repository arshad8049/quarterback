#!/usr/bin/env node
// KAN-110 review: apply the Proposal A audit (proposal-a.mjs) to the real candidates.
// Usage (from bench/, after qualify.mjs):  node public/proposal-a-audit.mjs [--yarn=classic|berry|classic,berry]
// Full dependency audit for every task whose runner Proposal A does not already block (Jest-only,
// or no identifiable runner); tasks blocked by another runner keep that blocker plus the npm
// restrictions already known. Reads yarn.lock / .yarnrc / .yarnrc.yml / package-lock.json at the
// base commit (cached GETs, never executed). Writes manifest/proposal-a.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, raw } from './qualify.mjs';
import { auditYarn, auditNpm, proposalA, yarnEntries } from './proposal-a.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const yarnArg = (process.argv.find((a) => a.startsWith('--yarn=')) || '--yarn=classic').slice(7).split(',');
const { tasks } = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest', 'candidates.json'), 'utf8'));
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const text = async (repo, c, p) => { const r = await get(raw(repo, c, p)); return r.status === 200 ? r.body : null; };

function runnersOf(f) {
  const s = new Set([...(f.runner_from_scripts?.frameworks || []), ...(f.runner_from_grader || [])]);
  if (f.qb_detected_runner && f.qb_detected_runner !== 'node-test') s.add(f.qb_detected_runner);
  return [...s];
}


/**
 * yarn.lock does not record install scripts. Resolve them from npm registry metadata
 * (abbreviated packuments: versions[v].hasInstallScript), read-only. A package whose metadata
 * cannot be read stays unresolved (the whole result is then null → unknown).
 */
async function classicInstallScripts(lockText) {
  const pairs = new Map();
  for (const e of yarnEntries(lockText, 'classic')) {
    if (!e.version || !/^https?:/.test(e.resolved || '')) continue;
    const first = e.key.split(/,\s*/)[0].replace(/^"|"$/g, '');
    const name = first.slice(0, first.lastIndexOf('@')) || first;
    pairs.set(`${name}@${e.version}`, { name, version: e.version });
  }
  const required = [];
  for (const { name, version } of pairs.values()) {
    const r = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, json: true });
    if (r.status !== 200 || !r.body || !r.body.versions) return null;
    const v = r.body.versions[version];
    if (!v) return null;
    if (v.hasInstallScript) required.push(name);
  }
  // yarn classic installs optional dependencies too; it does not record which are optional here
  return { required: [...new Set(required)].sort(), optional: [], source: 'npm registry metadata (hasInstallScript)' };
}

async function depsAudit(t) {
  const tree = await get(`https://api.github.com/repos/${t.repo}/git/trees/${t.base_commit}`, { json: true });
  const rootFiles = new Set(tree.status === 200 ? tree.body.tree.map((e) => e.path) : []);
  const pkg = parse(await text(t.repo, t.base_commit, 'package.json'));
  const hasYarn = rootFiles.has('yarn.lock'); const hasNpm = rootFiles.has('package-lock.json');
  if (hasNpm && !hasYarn) return auditNpm({ pkg, lock: parse(await text(t.repo, t.base_commit, 'package-lock.json')) || null });
  if (hasYarn) {
    const lockText = await text(t.repo, t.base_commit, 'yarn.lock');
    const yarnrc = rootFiles.has('.yarnrc') ? await text(t.repo, t.base_commit, '.yarnrc') : null;
    const yarnrcYml = rootFiles.has('.yarnrc.yml') ? await text(t.repo, t.base_commit, '.yarnrc.yml') : null;
    let a = auditYarn({ pkg, lockText, yarnrc, yarnrcYml, rootFiles });
    if (a.generation === 'classic' && !a.blockers.length) a = auditYarn({ pkg, lockText, yarnrc, yarnrcYml, rootFiles, installScripts: await classicInstallScripts(lockText) });
    if (hasNpm) a.unknowns = [...new Set([...a.unknowns, 'deps:both-npm-and-yarn-lockfiles'])].sort();
    return a;
  }
  const kind = rootFiles.has('pnpm-lock.yaml') ? 'deps:pnpm' : 'deps:no-lockfile';
  return { kind: 'none', blockers: [kind], unknowns: [], requirements: [], install_scripts: { required: [], optional: [] } };
}

const out = [];
for (const t of tasks) {
  if (t.duplicate_of) continue;
  const f = t.facts || {};
  const runners = runnersOf(f);
  const runnerBlocked = runners.some((r) => r !== 'jest');
  let deps;
  if (runnerBlocked) deps = { kind: 'not-audited', note: 'runner blocked under Proposal A; dependency audit not needed for the status', blockers: [], unknowns: [], requirements: [], install_scripts: { required: [], optional: [] } };
  else deps = await depsAudit(t);
  let jest_version = null;
  if (!runnerBlocked && deps.kind === 'npm') { const l = parse(await text(t.repo, t.base_commit, 'package-lock.json')); jest_version = l?.packages?.['node_modules/jest']?.version || null; }
  if (!runnerBlocked && deps.kind === 'yarn' && deps.generation === 'classic') { const lt = await text(t.repo, t.base_commit, 'yarn.lock'); const e = lt && yarnEntries(lt, 'classic').find((x) => /^"?jest@/.test(x.key)); jest_version = e ? e.version : null; }
  const r = proposalA({ runner_frameworks: runners, grader_evidence: f.grader_evidence, services: f.services || [], node: f.node || {}, deps }, { yarn: yarnArg });
  out.push({ task_id: t.task_id, source: t.source, repo: t.repo, base_commit: t.base_commit, status: r.status, jest_version, blockers: r.blockers, unknowns: r.unknowns, requirements: r.requirements, conditions: r.conditions,
    gold_overlap_flag: t.leak.gold_overlap_lines > 0, deps: deps.kind === 'not-audited' ? { kind: deps.kind } : { kind: deps.kind, generation: deps.generation ?? null, lock_sha256: deps.lock_sha256 ?? null, lockfile_version: deps.lockfile_version ?? null, config: deps.config ?? null, registries: deps.registries, integrity: deps.integrity, install_scripts: deps.install_scripts, protocols: deps.protocols ?? null, resolutions: deps.resolutions ?? null } });
}

const tally = (rows, key) => { const o = {}; for (const r of rows) { const k = key(r); const s = (o[k] ||= { eligible_static: 0, unknown: 0, incompatible: 0, gold_overlap_flagged: 0 }); s[r.status]++; if (r.gold_overlap_flag) s.gold_overlap_flagged++; } return o; };
const freq = (xs) => Object.fromEntries(Object.entries(xs.reduce((a, x) => ((a[x] = (a[x] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]));
const result = {
  schema: 'qb-public-proposal-a/1', yarn_generations_supported: yarnArg,
  note: 'Static. eligible_static = no blocker and nothing unresolved that a static read can settle; runtime is still unverified for every task (KAN-111). Gold-line overlap is a screening flag (counted, not excluded here).',
  jest_versions_eligible_or_unknown: freq(out.filter((r) => r.status !== 'incompatible' && r.jest_version).map((r) => r.jest_version)),
  by_source: tally(out, (r) => r.source), by_repo: tally(out, (r) => `${r.source} ${r.repo}`),
  blocker_frequency: freq(out.flatMap((r) => r.blockers)),
  unknown_frequency: freq(out.flatMap((r) => r.unknowns.map((u) => (u.startsWith('install:native-or-script-deps:') ? 'install:native-or-script-deps:<names>' : u)))),
  tasks: out,
};
fs.writeFileSync(path.join(HERE, 'manifest', 'proposal-a.json'), JSON.stringify({ ...result, tasks: undefined }, null, 2).replace(/\n}$/, ',\n  "tasks": [\n') + out.map((t) => '    ' + JSON.stringify(t)).join(',\n') + '\n  ]\n}\n');
console.log('yarn supported:', yarnArg.join(','));
for (const [k, v] of Object.entries(result.by_source)) console.log(k, JSON.stringify(v));
console.log('jest-relevant repos:'); for (const [k, v] of Object.entries(result.by_repo)) if (v.eligible_static || v.unknown || /prettier|babel|element|immutable|docusaurus|webclients|code-server|tailwind/.test(k)) console.log('  ', k, JSON.stringify(v));
console.log('blockers', JSON.stringify(result.blocker_frequency));
console.log('unknowns', JSON.stringify(result.unknown_frequency));
