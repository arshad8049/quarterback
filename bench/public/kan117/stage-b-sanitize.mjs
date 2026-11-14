#!/usr/bin/env node
// KAN-117 stage B: the ONLY way results leave the runner. Allowlisted fields, no patch text, no test names
// (identities are published as a set hash + counts only), no console tails from test or eval steps; then a scan
// for every required (FAIL_TO_PASS/PASS_TO_PASS) test name, diff text and secret patterns. Any hit: exit 1, nothing written.
//   node stage-b-sanitize.mjs <qbDir> <gradeDir> <store> <pubDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [qbDir, gradeDir, store, pubDir] = process.argv.slice(2);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const TAILLESS = new Set(['list', 'test']);

export function sanitizeQb(q) {
  const x = structuredClone(q);
  for (const r of Object.values(x.runs || {})) {
    if (!r || !r.verification) continue;
    const v = r.verification;
    for (const s of v.steps || []) if (TAILLESS.has(s.name)) delete s.stderr_tail;
    if (v.validation) { delete v.validation.identities; }
    delete v.output; delete v.report;
  }
  return x;
}
export function sanitizeGrade(g) {
  const x = structuredClone(g);
  const plan = x.plan || []; delete x.plan; x.plan_commands = plan.length; x.plan_sha256 = sha(plan.join('\n'));
  for (const s of (x.run && x.run.steps) || []) { delete s.stdout_tail; delete s.stderr_tail; }
  if (x.run) delete x.run.infra_detail;
  return x;
}
export function scan(text, names) {
  const hits = [];
  for (const n of names) if (n && text.includes(n)) hits.push('required test name');
  if (/diff --git|^@@ /m.test(text)) hits.push('diff text');
  if (/(ghp_|gho_|ghs_|ghu_|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-ant-)/.test(text)) hits.push('secret pattern');
  return [...new Set(hits)];
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  if (!qbDir || !gradeDir || !store || !pubDir) { console.error('usage: stage-b-sanitize.mjs <qbDir> <gradeDir> <store> <pubDir>'); process.exit(2); }
  const env = read(path.join(path.dirname(new URL(import.meta.url).pathname), 'task-2005.env.json'));
  const row = fs.readFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === env.task_id);
  const arr = (v) => (Array.isArray(v) ? v : JSON.parse(v));
  const names = [...arr(row.FAIL_TO_PASS), ...arr(row.PASS_TO_PASS)];
  const qb = sanitizeQb(read(path.join(qbDir, 'stage-b-qb.json')));
  const grades = {};
  for (const label of ['empty', 'gold']) {
    const f = path.join(gradeDir, `candidate-${label}.json`);
    grades[label] = fs.existsSync(f) ? sanitizeGrade(read(f)) : null;
    const c = path.join(qbDir, `candidate-${label}.diff`);
    if (fs.existsSync(c) && qb.candidates[label] && sha(fs.readFileSync(c)) !== qb.candidates[label].sha256) { console.error(`candidate-${label}.diff hash differs from the QB record`); process.exit(1); }
    if (grades[label] && qb.candidates[label] && grades[label].candidate.file_sha256 !== qb.candidates[label].sha256) { console.error(`grader graded a different ${label} candidate`); process.exit(1); }
  }
  const results = { schema: 'qb-kan117-stage-b-results/1', qb, grades };
  const text = JSON.stringify(results, null, 2);
  const hits = scan(text, names);
  if (hits.length) { console.error(`refused: ${hits.join(', ')}`); process.exit(1); }
  fs.mkdirSync(pubDir, { recursive: true });
  fs.writeFileSync(path.join(pubDir, 'results.json'), `${text}\n`);
  fs.writeFileSync(path.join(pubDir, 'sanitize-report.txt'), `scanned ${text.length} bytes for ${names.length} required test names, diff text and secret patterns: clean\nresults.json sha256 ${sha(`${text}\n`)}\n`);
  console.log('sanitized: clean');
}
