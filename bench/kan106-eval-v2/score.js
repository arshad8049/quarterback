#!/usr/bin/env node
/**
 * KAN-106 10838: score ONE profile's batch. No model call. Each launched item is scored by the v1 scorer's
 * scoreItem (record identity, artifact hashes, generated checks run unchanged on base and controls), against
 * expectations built from the FROZEN plan.json; a resource_blocked item stays resource_blocked; an item with no
 * batch entry is `missing`. Then the gates Q1-Q5 (gates.js) for this profile only.
 *
 *   node bench/kan106-eval-v2/score.js --batch-dir OUT --profile P [--rulings FILE] [--out FILE]
 *
 * Scoring must run at the frozen QB SHA: the v1 scorer reads `contractState` from the checkout it runs in
 * (the 881a51a pack scores differently at 2150ab6 than at e5c460d; see rescore-pinned.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const v1 = require('../kan106-eval-v1/score');
const { evaluateProfile } = require('./gates');

const QB_ROOT = path.join(__dirname, '..', '..');

function expectFromPlan(n, qbRevision) {
  return { qb_revision: qbRevision, model: n.model.name, profile: n.launch.l1_profile, l1_budget_ms: n.launch.l1_total_ms, per_call_ms: n.launch.per_call_ms,
    base_shas: n.held_out.base_shas, config: n.launch.expected_config, ollama_host: new URL(n.launch.ollama_url).host };
}
function rosterOf(n, itemsRoot) {
  return n.held_out.order.map((id) => ({ id, expected: JSON.parse(fs.readFileSync(path.join(itemsRoot, id, 'item.json'), 'utf8')).expected }));
}
/**
 * Secondary timing facts: load-excluded L1 time, whether the item paid a model load, and whether a load happened
 * that the admission did not plan for (keep-alive policy, plan.json resource_gate.keep_alive): ANY load in an item
 * admitted under the warm rule, or a load after the first call in an item admitted under the cold rule.
 */
function timingExtras(runDir, { admittedRule = null, loadMs = 1000 } = {}) {
  try {
    const t = v1.loadRun(runDir).timings;
    if (!t) return {};
    const calls = t.calls || [];
    const loads = calls.map((c) => c.load_ms).filter(Number.isFinite);
    const sum = loads.reduce((a, b) => a + b, 0);
    const big = calls.map((c, i) => ({ i, ms: c.load_ms })).filter((x) => Number.isFinite(x.ms) && x.ms >= loadMs);
    const unplanned = admittedRule === 'warm' ? big.length > 0 : admittedRule === 'cold' ? big.some((x) => x.i > 0) : null;
    return { l1_load_excluded_ms: Number.isFinite(t.l1_ms) ? t.l1_ms - sum : null, load_ms_total: sum, cold_load: big.length > 0,
      admitted_rule: admittedRule, unplanned_reload: unplanned, load_calls: big.map((x) => ({ call: x.i + 1, load_ms: x.ms })) };
  } catch { return {}; }
}

function scoreProfile({ batch, runs, runsRoot, itemsRoot, plan, profile, rulings = {} }) {
  const n = plan.normative;
  const roster = rosterOf(n, itemsRoot);
  const problems = [];
  if (!batch) problems.push('batch.json missing');
  else {
    if (batch.refused) problems.push(`the batch refused to start: ${(batch.reasons || []).join('; ')}`);
    if (batch.profile !== profile) problems.push(`batch profile ${batch.profile}, scoring ${profile}`);
    if (!batch.model_after || batch.model_after.digest_matches !== true) problems.push('the model digest after the batch was not confirmed unchanged');
  }
  const expect = expectFromPlan(n, batch && batch.qb_revision);
  const rows = roster.map(({ id, expected }) => {
    const entry = runs ? runs[id] : undefined;
    let row;
    if (!entry) row = { id, expected, result: 'missing', problems: ['no batch entry'] };
    else if (entry.status === 'resource_blocked') {
      const it = ((batch && batch.items) || []).find((x) => x.id === id);
      row = { id, expected, result: 'resource_blocked', gate: it ? it.gate : null, problems: [] };
    } else {
      try { row = v1.scoreItem(id, entry, { runsRoot, itemsRoot, expect }); } catch (e) { row = { id, expected, result: 'invalid_record', problems: [`scorer error: ${e.message}`] }; }
      const it = ((batch && batch.items) || []).find((x) => x.id === id);
      if (entry.run_id) Object.assign(row, timingExtras(path.join(runsRoot, entry.run_id), { admittedRule: it && it.gate ? it.gate.rule : null, loadMs: n.resource_gate.keep_alive.reload_detect_load_ms }));
    }
    if (problems.length && !['missing', 'resource_blocked', 'invalid_record'].includes(row.result)) { row.result_before_batch_check = row.result; row.result = 'invalid_record'; row.problems = [...(row.problems || []), ...problems]; }
    return row;
  });
  return { schema: 'qb-kan106-eval-v2-scores/1', profile, batch_problems: problems, rows, gates: evaluateProfile({ profile, roster, rows, rulings, policy: n.gates }) };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const out = opt('--batch-dir'); const profile = opt('--profile');
  if (!out || !profile) { console.error('usage: score.js --batch-dir OUT --profile P [--rulings FILE] [--out FILE]'); process.exit(2); }
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const plan = read(path.join(__dirname, 'plan.json'));
  const itemsRoot = path.join(QB_ROOT, plan.normative.held_out.items_dir);
  const r = scoreProfile({ batch: read(path.join(out, 'batch.json')), runs: read(path.join(out, 'runs.json')), runsRoot: path.join(out, 'runs'), itemsRoot, plan, profile,
    rulings: (read(opt('--rulings') || '') || {}).items || {} });
  const text = JSON.stringify(r, null, 2) + '\n';
  if (opt('--out')) fs.writeFileSync(opt('--out'), text); else process.stdout.write(text);
}
module.exports = { scoreProfile, expectFromPlan, timingExtras };
