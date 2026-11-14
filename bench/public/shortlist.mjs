#!/usr/bin/env node
// KAN-110 shortlist: applies the frozen rule in shortlist-rule.json to manifest/candidates.json.
// Deterministic; uses no outcomes. With no eligible task it selects nothing and says so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rule = JSON.parse(fs.readFileSync(path.join(HERE, 'shortlist-rule.json'), 'utf8'));
const { tasks } = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest', 'candidates.json'), 'utf8'));
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
if (h(rule.seed_input) !== rule.seed_sha256) throw new Error('seed does not match its frozen input');

export function eligible(t) {
  const reasons = [];
  if (t.classification.status !== 'compatible') reasons.push(`not compatible (${t.classification.status})`);
  if (t.duplicate_of) reasons.push('duplicate');
  if (t.leak.gold_overlap_lines > 0 && !t.gold_overlap_cleared) reasons.push('gold-overlap screening flag not cleared');
  if ((t.facts?.services || []).length) reasons.push('needs services');
  if (t.prior_exposure_arshad == null) reasons.push('prior exposure not yet recorded');
  else if (/contributed|inspected/.test(t.prior_exposure_arshad)) reasons.push('prior exposure');
  return reasons;
}

export function select(list) {
  const picks = []; const shortfall = {};
  const order = (src) => list.filter((t) => t.source === src && !eligible(t).length).sort((a, b) => h(rule.seed_sha256 + '|' + a.task_id).localeCompare(h(rule.seed_sha256 + '|' + b.task_id)));
  const pools = Object.fromEntries(rule.target.sources.map((s) => [s, order(s)]));
  for (const s of rule.target.sources) {
    const pool = pools[s]; const repos = new Set(pool.map((t) => t.repo)); const chosen = [];
    for (const t of pool) { if (chosen.length >= rule.target.per_source) break; if (chosen.some((c) => c.repo === t.repo) && chosen.length < repos.size) continue; chosen.push(t); }
    for (const t of pool) { if (chosen.length >= rule.target.per_source) break; if (!chosen.includes(t)) chosen.push(t); }
    picks.push(...chosen); if (chosen.length < rule.target.per_source) shortfall[s] = rule.target.per_source - chosen.length;
  }
  return { picks, shortfall };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { picks, shortfall } = select(tasks);
  const why = {}; tasks.forEach((t) => eligible(t).forEach((r) => { const k = `${t.source}: ${r}`; why[k] = (why[k] || 0) + 1; }));
  const out = { schema: 'qb-public-shortlist/1', rule: 'shortlist-rule.json', seed_sha256: rule.seed_sha256, selected: picks.map((t) => ({ task_id: t.task_id, source: t.source, repo: t.repo })), shortfall, exclusion_counts: why,
    result: picks.length ? 'selected by the frozen rule' : rule.if_none_eligible };
  fs.writeFileSync(path.join(HERE, 'manifest', 'shortlist.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`selected ${picks.length}; shortfall ${JSON.stringify(shortfall)}; ${out.result}`);
}
