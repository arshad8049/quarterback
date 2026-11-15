#!/usr/bin/env node
// Arm A: the independent grade's public record. Stage-B allowlist (no plan, no step tails, no infra detail),
// bound to the exact captured bytes (the grader's file hash must equal the trial's candidate hash).
//   node arm-a-grade-sanitize.mjs <gradeDir> <restrictedDir> <store> <pubDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeGrade, scan } from '../public/kan117/stage-b-sanitize.mjs';

const [gDir, rDir, store, pubDir] = process.argv.slice(2);
if (!gDir || !rDir || !store || !pubDir) { console.error('usage: arm-a-grade-sanitize.mjs <gradeDir> <restrictedDir> <store> <pubDir>'); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rec = JSON.parse(fs.readFileSync(path.join(rDir, 'candidate.json'), 'utf8'));
const trial = JSON.parse(fs.readFileSync(path.join(rDir, 'trial.json'), 'utf8'));
if (sha(fs.readFileSync(path.join(rDir, 'candidate.diff'))) !== rec.sha256) { console.error('candidate.diff differs from its record'); process.exit(1); }
const f = path.join(gDir, `candidate-${rec.label}.json`);
if (!fs.existsSync(f)) { console.error('no grade result'); process.exit(1); }
const g = sanitizeGrade(JSON.parse(fs.readFileSync(f, 'utf8')));
if (g.candidate.file_sha256 !== rec.sha256) { console.error('the grader graded different bytes'); process.exit(1); }
const vault = fs.readFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === rec.task_id);
const arr = (v) => (Array.isArray(v) ? v : JSON.parse(v));
const r = g.run || {};
const outcome = r.outcome !== 'graded' ? `not graded (${r.outcome}${r.invalid_kind ? `, ${r.invalid_kind}` : ''})`
  : !r.grade || !r.grade.evidence_valid ? 'not graded (invalid evidence)' : r.grade.official === 'RESOLVED_FULL' ? 'solved' : 'not solved';
const out = { schema: 'qb-arm-a-grade/1', task: trial.task, task_id: rec.task_id, freeze: trial.freeze, dry_run: trial.dry_run, trial_primary: trial.primary,
  candidate_sha256: rec.sha256, candidate_bytes: rec.bytes, outcome, grade: g };
const text = JSON.stringify(out, null, 2);
const hits = scan(text, [...arr(vault.FAIL_TO_PASS), ...arr(vault.PASS_TO_PASS)]);
if (hits.length) { console.error(`refused: ${hits.join(', ')}`); process.exit(1); }
fs.mkdirSync(pubDir, { recursive: true });
fs.writeFileSync(path.join(pubDir, `grade-${trial.task}.json`), `${text}\n`);
console.log(JSON.stringify({ task: trial.task, outcome, official: r.grade ? r.grade.official : null }));
