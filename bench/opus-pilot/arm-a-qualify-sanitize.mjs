#!/usr/bin/env node
// Arm-A batch 1: the ONLY way a task's qualification leaves the runner. Joins the setup record
// (arm-a-qualify.mjs) and the KAN-111 calibration summary (grade.mjs --tasks-file --only) into one public record.
// Allowlist: outcomes, gates, counts and hashes; no step tails, no infra detail, no plan, no test names, no patch text.
//   node arm-a-qualify-sanitize.mjs <key> <qualifyDir> <calibDir> <store> <pubDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scan } from '../public/kan117/stage-b-sanitize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [key, qDir, cDir, store, pubDir] = process.argv.slice(2);
if (!key || !qDir || !cDir || !store || !pubDir) { console.error('usage: arm-a-qualify-sanitize.mjs <key> <qualifyDir> <calibDir> <store> <pubDir>'); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readIf = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const t = JSON.parse(fs.readFileSync(path.join(HERE, 'arm-a-grader-tasks.json'), 'utf8')).tasks[key];
const vault = fs.readFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === t.task_id);
const arr = (v) => (Array.isArray(v) ? v : JSON.parse(v));
const names = [...arr(vault.FAIL_TO_PASS), ...arr(vault.PASS_TO_PASS)];

const q = readIf(path.join(qDir, `qualify-${key}.json`));
const s = readIf(path.join(cDir, 'summary.json'));
const calib = s ? {
  adaptation: s.adaptation, harness: s.harness, tasks_file_sha256: s.tasks_file_sha256, approved_by: s.approved_by, gates_passed: s.gates_passed,
  runs: (s.runs || []).filter((r) => r.task === key).map((r) => ({ label: r.label, rep: r.rep, variant: r.variant, outcome: r.outcome, infra_step: r.infra_step || null,
    accepted: r.grade ? r.grade.accepted ?? null : null, official: r.grade ? r.grade.official ?? null : null, log_gate: r.grade ? r.grade.log_gate : null,
    expectation_met: r.expectation_met, expectation_failures: r.expectation_failures, wall_s: r.wall_s ?? null, eval_sha256: r.eval_sha256 || null,
    official_eval_sha256: r.official_eval_sha256 || null, helpers: r.helpers || null })),
} : null;
const setupOk = q && q.qualified_setup === 'pending_calibration';
const out = {
  schema: 'qb-arm-a-qualification/1', task: key, task_id: t.task_id, instance_id: t.instance_id, role: t.role, image: t.image,
  qualified: Boolean(setupOk && calib && calib.gates_passed === true),
  failure: !q ? { where: 'qualify', why: 'no setup record' } : (q.setup_failure || (!calib ? { where: 'calibration', why: 'no calibration summary' }
    : (calib.gates_passed !== true ? { where: 'calibration', why: 'KAN-111 calibration expectations not met' } : null))),
  setup: q, calibration: calib,
};
const text = JSON.stringify(out, null, 2);
const hits = scan(text, names);
if (hits.length) { console.error(`refused: ${hits.join(', ')}`); process.exit(1); }
fs.mkdirSync(pubDir, { recursive: true });
fs.writeFileSync(path.join(pubDir, `qualification-${key}.json`), `${text}\n`);
console.log(JSON.stringify({ task: key, qualified: out.qualified, failure: out.failure, sha256: sha(`${text}\n`) }));
