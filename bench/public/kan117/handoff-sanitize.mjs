#!/usr/bin/env node
// KAN-117 (review 10609): the ONLY way handoff results leave the runner. Reuses the stage-B allowlist
// (no test names, identities as a set hash, no step tails, no patch text) and adds: no briefing text
// (the bundle is published as hashes), and no gold-patch line. Any hit: exit 1, nothing written.
//   node handoff-sanitize.mjs <qbDir> <gradeDir> <imagesDir> <store> <pubDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sanitizeQb, sanitizeGrade, scan } from './stage-b-sanitize.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { addedLines } = require(path.join(HERE, '..', '..', '..', 'lib/research/agent-bundle.js'));
const [qbDir, gradeDir, imagesDir, store, pubDir] = process.argv.slice(2);
if (!qbDir || !gradeDir || !imagesDir || !store || !pubDir) { console.error('usage: handoff-sanitize.mjs <qbDir> <gradeDir> <imagesDir> <store> <pubDir>'); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readIf = (f) => (fs.existsSync(f) ? read(f) : null);

const env = read(path.join(HERE, 'task-2005.env.json'));
const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === env.task_id);
const vault = row('vault'); const agent = row('agent');
const arr = (v) => (Array.isArray(v) ? v : JSON.parse(v));
const names = [...arr(vault.FAIL_TO_PASS), ...arr(vault.PASS_TO_PASS)];

const qb = sanitizeQb(read(path.join(qbDir, 'handoff-qb.json')));
const grades = {}; const notGraded = {};
for (const label of Object.keys(qb.candidates || {})) {
  const g = readIf(path.join(gradeDir, `candidate-${label}.json`));
  grades[label] = g ? sanitizeGrade(g) : null;
  notGraded[label] = readIf(path.join(gradeDir, `not-graded-${label}.json`));
  const d = path.join(qbDir, `candidate-${label}.diff`);
  if (sha(fs.readFileSync(d)) !== qb.candidates[label].sha256) { console.error(`candidate-${label}.diff differs from its record`); process.exit(1); }
  if (g && g.candidate.file_sha256 !== qb.candidates[label].sha256) { console.error(`grader graded different ${label} bytes`); process.exit(1); }
}
const results = {
  schema: 'qb-kan117-handoff-results/1', qb, grades, not_graded: notGraded,
  image_provenance: read(path.join(imagesDir, 'image-provenance.json')), image_load: read(path.join(imagesDir, 'load-verification.json')),
  launch_spec: read(path.join(qbDir, 'launch-spec.json')),
};
const text = JSON.stringify(results, null, 2);
const hits = scan(text, names);
const ps = agent.problem_statement.replace(/\s+/g, ' ').trim();
for (let i = 0; i + 40 <= ps.length; i += 40) if (text.includes(ps.slice(i, i + 40))) { hits.push('briefing text'); break; }
if (addedLines(vault.patch).some((l) => text.includes(l))) hits.push('gold patch line');
if (hits.length) { console.error(`refused: ${[...new Set(hits)].join(', ')}`); process.exit(1); }
fs.mkdirSync(pubDir, { recursive: true });
fs.writeFileSync(path.join(pubDir, 'results.json'), `${text}\n`);
fs.writeFileSync(path.join(pubDir, 'sanitize-report.txt'), `scanned ${text.length} bytes for ${names.length} required test names, briefing text, gold lines, diff text and secret patterns: clean\nresults.json sha256 ${sha(`${text}\n`)}\n`);
console.log('sanitized: clean');
