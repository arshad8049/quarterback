#!/usr/bin/env node
// KAN-110 adapter analysis. Usage (from bench/, after qualify.mjs):  node public/adapters.mjs
// No task is compatible with QB at 784e721, so this answers "what is the SMALLEST explicit QB
// change that would make a diverse pilot possible?" It tags every task's blockers, then counts the
// tasks each set of up to 3 adapters would unlock (a task is unlocked only if ALL its blockers are
// covered). This is a static estimate for Arshad's scope decision, not a selection: no task is
// chosen here, and nothing is converted or relaxed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { tasks } = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest', 'candidates.json'), 'utf8'));

/** Node major implied by the strongest hint (setup image or nvm, then .nvmrc, then engines). */
export function nodeMajor(n = {}) {
  for (const v of [n.image_or_setup, n.nvmrc, n.node_version_file]) { const m = /(\d+)/.exec(v || ''); if (m) return Number(m[1]); }
  return null;
}

/** Blocker tags for one task (each maps to one possible QB adapter). */
export function blockers(t) {
  const f = t.facts || {}; const b = new Set();
  if (f.fetch_error) { b.add('unverifiable'); return b; }
  const runners = new Set([...(f.runner_from_scripts?.frameworks || []), ...(f.runner_from_grader || [])]);
  if (f.qb_detected_runner && f.qb_detected_runner !== 'node-test') runners.add(f.qb_detected_runner);
  runners.delete('node-test');
  if (runners.size) runners.forEach((r) => b.add(`runner:${r}`));
  else if (!(f.runner_from_scripts?.frameworks || []).includes('node-test')) b.add('runner:unidentified');
  const dp = f.qb_deps_plan || {};
  const locks = f.package_manager?.lockfiles || [];
  if (dp.reason === 'setup_missing_lockfile') b.add(locks.includes('yarn') ? 'deps:yarn' : locks.includes('pnpm') ? 'deps:pnpm' : 'deps:no-lockfile');
  if (/lockfileVersion/.test(dp.detail || '')) b.add('deps:npm-lockfile-v1');
  if (/workspaces/.test(dp.detail || '') || f.workspaces) b.add('deps:workspaces'); // deps-plan stops at a missing lockfile: use the recorded flag too
  if (/lifecycle/.test(dp.detail || '')) b.add('deps:lifecycle-scripts');
  if (/file:\/link:\/git/.test(dp.detail || '')) b.add('deps:git-or-file-deps');
  if (f.qb_test_plan?.reason === 'no_test_command') b.add('layout:no-root-test-script');
  (f.services || []).forEach((s) => b.add(`service:${s}`));
  const nm = nodeMajor(f.node); if (nm != null && nm < 20) b.add('runtime:node<20');
  return b;
}

// What each adapter would mean in QB terms, with a rough size. Services and old runtimes are
// listed but are not "small": they need network-policy or sandbox-image changes.
export const ADAPTERS = {
  'runner:jest': 'Run Jest and parse its JSON reporter into QB per-test results (new validated runner).',
  'runner:mocha': 'Run Mocha and parse its JSON reporter (new validated runner).',
  'runner:vitest': 'Run Vitest and parse its JSON reporter (new validated runner).',
  'runner:qunit': 'Run QUnit (three.js, browser-less) and parse results.',
  'runner:karma': 'Karma needs a browser: large (service + runner).',
  'runner:tap': 'Run tap and parse TAP output.',
  'runner:unidentified': 'Custom or undiscovered test entry point: needs per-repository work.',
  'deps:yarn': 'Install from yarn.lock (classic/berry) behind the same registry-only proxy.',
  'deps:pnpm': 'Install from pnpm-lock.yaml behind the same registry-only proxy.',
  'deps:no-lockfile': 'No lockfile: install would be unpinned. Not recommended.',
  'deps:npm-lockfile-v1': 'Accept npm lockfile v1 (npm ci upgrades it in place).',
  'deps:workspaces': 'Allow npm workspaces in the sandbox install.',
  'deps:lifecycle-scripts': 'Allow root lifecycle scripts (e.g. prepare), which run repository code at install time.',
  'deps:git-or-file-deps': 'Allow git/file dependencies (needs network beyond the npm registry).',
  'layout:no-root-test-script': 'Monorepo without a root test script: per-package test commands.',
  'runtime:node<20': 'Sandbox image with an older pinned Node (QB image is Node 24).',
  'unverifiable': 'Repository could not be read.',
};
const NOT_SMALL = (a) => a.startsWith('service:') || a === 'runtime:node<20' || a === 'deps:no-lockfile' || a === 'deps:git-or-file-deps' || a === 'unverifiable' || a === 'runner:unidentified' || a === 'runner:karma';

export function analyse() {
  const eligible = tasks.filter((t) => !t.duplicate_of);
  const tagged = eligible.map((t) => ({ t, b: [...blockers(t)] }));
  const freq = {}; tagged.forEach(({ b }) => b.forEach((x) => { freq[x] = (freq[x] || 0) + 1; }));
  const candidates = Object.keys(freq).filter((a) => !NOT_SMALL(a));
  const combos = [];
  const k3 = (arr, k, start = 0, cur = []) => { if (cur.length) combos.push([...cur]); if (cur.length === k) return; for (let i = start; i < arr.length; i++) { cur.push(arr[i]); k3(arr, k, i + 1, cur); cur.pop(); } };
  k3(candidates.sort(), 3);
  const results = combos.map((c) => {
    const set = new Set(c);
    const un = tagged.filter(({ b }) => b.length && b.every((x) => set.has(x)));
    const bySource = {}; const byRepo = {};
    un.forEach(({ t }) => { bySource[t.source] = (bySource[t.source] || 0) + 1; byRepo[t.repo] = (byRepo[t.repo] || 0) + 1; });
    const clean = un.filter(({ t }) => !t.leak.gold_overlap_lines);
    return { adapters: c, unlocked: un.length, unlocked_without_gold_overlap: clean.length, sources: Object.keys(bySource).length, by_source: bySource, by_repo: byRepo };
  }).filter((r) => r.unlocked > 0);
  results.sort((a, b) => b.sources - a.sources || a.adapters.length - b.adapters.length || Object.keys(b.by_repo).length - Object.keys(a.by_repo).length || b.unlocked - a.unlocked);
  return { blocker_frequency: Object.fromEntries(Object.entries(freq).sort((a, b) => b[1] - a[1])), adapters: ADAPTERS, single_blocker_tasks: tagged.filter(({ b }) => b.length === 1).length, combos: results.slice(0, 25) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = analyse();
  fs.writeFileSync(path.join(HERE, 'manifest', 'adapter-analysis.json'), JSON.stringify({ schema: 'qb-public-adapter-analysis/1', note: 'Static estimate for a scope decision. Not a selection. A task counts as unlocked only if every blocker is covered.', ...a }, null, 2) + '\n');
  console.log('blockers:', JSON.stringify(a.blocker_frequency));
  console.log('tasks with exactly one blocker:', a.single_blocker_tasks);
  a.combos.slice(0, 12).forEach((r) => console.log(`${r.adapters.join(' + ')} -> ${r.unlocked} (${r.unlocked_without_gold_overlap} w/o overlap) sources ${r.sources} ${JSON.stringify(r.by_repo)}`));
}
