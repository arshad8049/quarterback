#!/usr/bin/env node
/**
 * KAN-106 10838 fix (2): the plan document and plan.json must AGREE, or the batch REFUSES to launch.
 * (Plan v2 said "if the two disagree, the JSON wins"; that silent preference is withdrawn.)
 *
 *   node bench/kan106-eval-v2/plan-check.js [--doc FILE] [--plan FILE]     exit 0 when consistent, 1 otherwise
 *   node bench/kan106-eval-v2/plan-check.js --print-table                   the hash line and table to paste (authoring aid)
 *
 * What is machine-checked:
 *   1. The document names the sha256 of plan.json's exact bytes on one line: plan.json sha256: `<64 hex>`.
 *      Any edit to plan.json without the matching document edit is a disagreement.
 *   2. The document's "Normative values" table (rows: | `dotted.key` | `<JSON literal>` |) lists EXACTLY the
 *      leaves of plan.json `normative` (arrays are leaves), each once, each JSON-equal.
 *   3. plan.json `doc` names this document; the document does not carry the withdrawn "JSON wins" rule.
 * What is NOT machine-checked: prose outside the table. Reviewers check that it matches the table.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PLAN = path.join(__dirname, 'plan.json');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function leaves(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out); else out[key] = v;
  }
  return out;
}
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));

function tableOf(docText) {
  const rows = [];
  const start = docText.search(/^#+ .*Normative values/m);
  if (start < 0) return null;
  const rest = docText.slice(start).split('\n').slice(1);
  let seenTable = false;
  for (const line of rest) {
    if (/^#+ /.test(line)) break;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`(.*)`\s*\|\s*$/);
    if (m) { rows.push({ key: m[1], raw: m[2] }); seenTable = true; } else if (seenTable && !/^\|/.test(line) && line.trim()) break;
  }
  return rows;
}

function checkPlan({ docText, planBuf, docRel }) {
  const problems = [];
  let plan;
  try { plan = JSON.parse(planBuf.toString('utf8')); } catch (e) { return [`plan.json is not valid JSON (${e.message})`]; }
  if (docRel && plan.doc !== docRel) problems.push(`plan.json "doc" is ${JSON.stringify(plan.doc)}, not ${JSON.stringify(docRel)}`);
  const hashes = [...docText.matchAll(/^plan\.json sha256: `([0-9a-f]{64})`\s*$/gm)].map((m) => m[1]);
  if (hashes.length !== 1) problems.push(`the document must name plan.json's sha256 exactly once (found ${hashes.length})`);
  else if (hashes[0] !== sha256(planBuf)) problems.push(`the document names plan.json sha256 ${hashes[0]}, but plan.json is ${sha256(planBuf)}`);
  if (/JSON wins/i.test(docText)) problems.push('the document still carries the withdrawn "JSON wins" rule');
  if (!plan.normative || typeof plan.normative !== 'object') { problems.push('plan.json has no "normative" object'); return problems; }
  const want = leaves(plan.normative);
  const rows = tableOf(docText);
  if (!rows) { problems.push('the document has no "Normative values" section'); return problems; }
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.key)) { problems.push(`${r.key}: listed more than once in the document`); continue; }
    seen.add(r.key);
    if (!(r.key in want)) { problems.push(`${r.key}: in the document, not in plan.json normative`); continue; }
    let v;
    try { v = JSON.parse(r.raw); } catch { problems.push(`${r.key}: the document value ${r.raw} is not a JSON literal`); continue; }
    if (canon(v) !== canon(want[r.key])) problems.push(`${r.key}: document ${canon(v)} != plan.json ${canon(want[r.key])}`);
  }
  for (const k of Object.keys(want)) if (!seen.has(k)) problems.push(`${k}: in plan.json normative, missing from the document`);
  return problems;
}

function checkFiles({ planPath = DEFAULT_PLAN, docPath = null } = {}) {
  let planBuf;
  try { planBuf = fs.readFileSync(planPath); } catch { return { problems: [`${planPath}: missing`] }; }
  let plan = null;
  try { plan = JSON.parse(planBuf.toString('utf8')); } catch { /* reported by checkPlan */ }
  const doc = docPath || (plan && plan.doc ? path.join(ROOT, plan.doc) : null);
  if (!doc) return { problems: ['plan.json names no document'] };
  let docText;
  try { docText = fs.readFileSync(doc, 'utf8'); } catch { return { problems: [`${doc}: missing`] }; }
  return { plan, problems: checkPlan({ docText, planBuf, docRel: docPath ? null : plan.doc }), plan_sha256: sha256(planBuf), doc_sha256: sha256(Buffer.from(docText)) };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  if (a.includes('--print-table')) {
    const planBuf = fs.readFileSync(opt('--plan') || DEFAULT_PLAN);
    const rows = Object.entries(leaves(JSON.parse(planBuf.toString('utf8')).normative)).map(([k, v]) => `| \`${k}\` | \`${JSON.stringify(v)}\` |`);
    process.stdout.write(`plan.json sha256: \`${sha256(planBuf)}\`\n\n| key | value |\n|---|---|\n${rows.join('\n')}\n`);
    process.exit(0);
  }
  const r = checkFiles({ planPath: opt('--plan') || DEFAULT_PLAN, docPath: opt('--doc') });
  if (r.problems.length) { console.error('✗ the plan document and plan.json disagree; the batch refuses to launch:\n  ' + r.problems.join('\n  ')); process.exit(1); }
  console.log(`✓ plan document and plan.json agree (plan.json ${r.plan_sha256})`);
}
module.exports = { checkPlan, checkFiles, leaves, tableOf };
