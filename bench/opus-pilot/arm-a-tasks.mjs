#!/usr/bin/env node
// Build the reviewed grader tasks file for arm-A batch 1 from the batch (arm-a-batch-1.json) and the
// grader vault (bench/public/out, rebuilt from the hash-verified dataset). Grader-side only: the agent
// never sees this file's inputs. Calibrates the selected tasks AND the first reserves, in reserve order.
//   node bench/opus-pilot/arm-a-tasks.mjs --store=<bench/public/out> [--reserves=3] [--write]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Files the official test patch MODIFIES (exist at base), in patch order: the grader's tamper/boundary targets. */
export function modifiedTestFiles(testPatch) {
  const out = [];
  for (const block of String(testPatch).split(/^diff --git /m).slice(1)) {
    const m = /^a\/(\S+) b\/(\S+)/.exec(block);
    if (!m || /^new file mode/m.test(block) || /^--- \/dev\/null/m.test(block)) continue;
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

export const keyOf = (instanceId) => instanceId.replace(/^[^_]+__/, '').replace(/^(preact|axios|three\.js)-/, (m) => m.replace('three.js', 'threejs'));

export function buildTasks(batch, ctl, vault, reserves = 3) {
  const list = [...batch.selected, ...batch.reserve.slice(0, reserves)];
  const tasks = {};
  for (const b of list) {
    const c = ctl.get(b.task_id); const v = vault.get(b.task_id);
    if (!c || !v || c.instance_id !== b.instance_id || c.base_commit !== b.base_commit) throw new Error(`store rows for ${b.instance_id} missing or mismatched`);
    const files = modifiedTestFiles(v.test_patch);
    tasks[keyOf(b.instance_id)] = { task_id: b.task_id, instance_id: b.instance_id, base: b.base_commit, image: b.image,
      eval_sha256: sha(v.eval_script), test_files: files, variant: 'A0', repo: c.repo, log_parser: v.log_parser,
      role: batch.selected.includes(b) ? `selected ${batch.selected.indexOf(b) + 1}` : `reserve ${batch.reserve.indexOf(b) + 1}` };
  }
  return { schema: 'qb-arm-a-grader-tasks/1', task_list_id: batch.task_list_id, batch_sha256: batch.__sha256 || null, tasks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = arg('store'); if (!store) { console.error('usage: arm-a-tasks.mjs --store=<bench/public/out> [--reserves=3] [--write]'); process.exit(2); }
  const bbuf = fs.readFileSync(path.join(HERE, 'arm-a-batch-1.json'));
  const batch = JSON.parse(bbuf); batch.__sha256 = sha(bbuf);
  const jl = (f) => new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { const x = JSON.parse(l); return [x.task_id, x]; }));
  const t = buildTasks(batch, jl(path.join(store, 'controller', 'swe-bench-multilingual.jsonl')), jl(path.join(store, 'vault', 'swe-bench-multilingual.jsonl')), Number(arg('reserves', 3)));
  const text = `${JSON.stringify(t, null, 2)}\n`;
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(HERE, 'arm-a-grader-tasks.json'), text);
  console.log(JSON.stringify({ sha256: sha(text), tasks: Object.fromEntries(Object.entries(t.tasks).map(([k, x]) => [k, `${x.role} ${x.log_parser} files=${x.test_files.length}`])) }, null, 1));
}
