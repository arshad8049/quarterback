#!/usr/bin/env node
// Arm-A batch 1 (owner plan 2026-11-14): a SEEDED selection of fresh SWE-bench Multilingual candidates.
// The order is sha256(seed + task_id), so it is reproducible and independent of anything about the
// tasks' solutions. The first `picks` are the batch; the rest is the reserve order, used ONLY to replace
// a task that fails setup qualification (never because Claude fails it).
//   node bench/opus-pilot/arm-a-select.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const SEED = 'qb-arm-a-batch-1-2026-11-14';
export const PICKS = 5;
export const SETUP_EXAMPLES = ['qbt_9b9a5da937c9', 'qbt_00b20b1b0285'];   // immutable-js 2005/2006: calibration examples, never fresh

/** The candidate pool: Multilingual, npm only, no services, no workspaces, not a setup example. */
export function pool(candidates) {
  return candidates.tasks.filter((t) => t.source === 'swe-bench-multilingual' && !SETUP_EXAMPLES.includes(t.task_id)
    && JSON.stringify(t.facts.package_manager.used_by_setup_or_grader || []) === '["npm"]'
    && !(t.facts.services || []).length && t.facts.workspaces === false
    && /^sha256:[0-9a-f]{64}$/.test((t.facts.image || {}).digest || ''));
}

export function order(tasks, seed = SEED) {
  const key = (t) => crypto.createHash('sha256').update(`${seed}\0${t.task_id}`).digest('hex');
  return [...tasks].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function batch(candidates, { seed = SEED, picks = PICKS } = {}) {
  const o = order(pool(candidates), seed);
  const row = (t) => ({ task_id: t.task_id, instance_id: t.instance_id, repo: t.repo, base_commit: t.base_commit,
    image: `${t.facts.image.ref.replace(/:[^:/]+$/, '')}@${t.facts.image.digest}`, grader_runner: t.facts.runner_from_grader || [] });
  return { schema: 'qb-arm-a-batch/1', task_list_id: 'arm-a-batch-1', seed, picks, pool_rule: 'swe-bench-multilingual, npm only, no services, no workspaces, pinned image digest, not 2005/2006',
    pool_size: o.length, candidates_sha256: candidates.__sha256 || null, selected: o.slice(0, picks).map(row), reserve: o.slice(picks).map(row),
    exposure: 'fresh (not a setup example); exploratory Claude-only; not a paired-comparison task' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = path.join(ROOT, 'bench/public/manifest/candidates.json');
  const buf = fs.readFileSync(f);
  const c = JSON.parse(buf); c.__sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const b = batch(c);
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(HERE, 'arm-a-batch-1.json'), `${JSON.stringify(b, null, 2)}\n`);
  console.log(JSON.stringify({ pool: b.pool_size, selected: b.selected.map((x) => x.instance_id), reserve: b.reserve.slice(0, 6).map((x) => x.instance_id) }, null, 1));
}
