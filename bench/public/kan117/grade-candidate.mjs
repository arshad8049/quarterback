#!/usr/bin/env node
// KAN-117 (review 10609): the pinned entrypoint that grades ANY captured candidate patch with the
// independent KAN-111 grader (immutable-offline-v1, variant A1, candidate mode). Run after capture,
// outside the coding budget, in a directory no QB run reads.
//   node bench/public/kan117/grade-candidate.mjs --record=<candidate-<label>.json> --diff=<candidate-<label>.diff> --out=<dir>
// 1. Checks the diff bytes against the QB capture record (lib/research/candidate.js) and the task env.
// 2. A not-gradable capture (policy refusal, unresolved, no capture) is recorded, never graded: exit 4.
// 3. Otherwise runs grade.mjs --candidate with the approvals.json citation; exits with the grader's code
//    (0 graded, 3 invalid/harness outcome) and fails (1) if the grader hashed different bytes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const { checkCandidate } = require(path.join(ROOT, 'lib/research/candidate.js'));
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const die = (code, m) => { console.error(m); process.exit(code); };

const recFile = arg('record'); const diffFile = arg('diff'); const out = arg('out');
if (!recFile || !diffFile || !out) die(2, 'usage: grade-candidate.mjs --record=<json> --diff=<file> --out=<dir>');

let grader = path.join(ROOT, 'bench/public/grader/immutable-offline-v1/grade.mjs');
if (process.env.QB_KAN117_TEST_GRADER) {
  if (process.env.GITHUB_ACTIONS === 'true') die(2, 'refusing: a test grader is never used in CI');
  grader = process.env.QB_KAN117_TEST_GRADER;
}

const env = JSON.parse(fs.readFileSync(path.join(HERE, 'task-2005.env.json'), 'utf8'));
const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
const diff = fs.readFileSync(diffFile);
try { checkCandidate(rec, diff, env); } catch (e) { die(2, `refusing: ${e.message}`); }

fs.mkdirSync(out, { recursive: true });
if (!rec.gradable) {
  fs.writeFileSync(path.join(out, `not-graded-${rec.label}.json`), `${JSON.stringify({ label: rec.label, sha256: rec.sha256, reason: rec.not_gradable_reason, graded: false }, null, 2)}\n`);
  console.log(`not graded: ${rec.label} (${rec.not_gradable_reason})`);
  process.exit(4);
}

const approvals = JSON.parse(fs.readFileSync(path.join(HERE, 'approvals.json'), 'utf8'));
const id = approvals.candidate_grade && approvals.candidate_grade.approval_comment_id;
if (!Number.isInteger(id)) die(2, 'refusing: candidate grading is not approved in approvals.json');

const r = spawnSync(process.execPath, [grader, '--execute', `--approved-by=${id}`, `--variant=${approvals.candidate_grade.variant || 'A1'}`,
  `--candidate=${path.resolve(diffFile)}`, `--task=${rec.grader_task}`, `--label=${rec.label}`, `--out=${path.resolve(out)}`], { stdio: 'inherit' });
if (r.status !== 0 && r.status !== 3) process.exit(r.status === null ? 1 : r.status);
const f = path.join(out, `candidate-${rec.label}.json`);
const res = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
if (!res || !res.candidate || res.candidate.file_sha256 !== rec.sha256) die(1, `grader result for ${rec.label} is missing or graded different bytes`);
process.exit(r.status);
