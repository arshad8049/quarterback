#!/usr/bin/env node
/**
 * bench/kan106-eval-v1/replay-validators.js — KAN-106 unresolved-case mapping (offline, no model).
 *
 * Feeds the EIGHT RECORDED contracts of the 2026-11-19 batch (generation 881a51a) back through the
 * CURRENT checkout's contractState(), twice per item:
 *   recorded  — the contract byte-for-byte as recorded (its own api_grounding)
 *   regrounded — the same contract with api_grounding recomputed by THIS checkout's groundApi() on the
 *                item's frozen base repo (what QB at this revision would attach)
 * For runs that produced no contract (U1 refused before drafting) it reports that.
 *
 * This replays validation only. It does NOT regenerate contracts, so it says nothing about what the
 * model would now produce, and the staged pre-generation stops (e.g. U2's vague-qualifier refusal)
 * are reported separately from the request text alone.
 *
 * Usage: node bench/kan106-eval-v1/replay-validators.js --pack <evidence pack dir> [--pack-commit sha] [--validators-commit sha] [--out file.json]
 *   The pack lives on kan106-staged-l1: git archive e5c460d docs/research/kan106/2026-11-19-eval-v1-881a51a | tar -x -C <dir>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { contractState } = require('../../intent/contract-state');
const { groundApi, contractGrounding } = require('../../intent/api-grounding');
const RX = require('../../intent/request-examples');

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const pack = arg('--pack');
if (!pack) { console.error('usage: replay-validators.js --pack <dir> [--out file]'); process.exit(2); }
const items = path.join(__dirname, 'items');
const runs = JSON.parse(fs.readFileSync(path.join(pack, 'runs.json'), 'utf8'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const out = { schema: 'qb-kan106-replay/1', pack: path.basename(pack), pack_commit: arg('--pack-commit'), validators_commit: arg('--validators-commit'), items: {} };

for (const [id, r] of Object.entries(runs)) {
  const dir = path.join(pack, 'runs', r.run_id);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const request = fs.readFileSync(path.join(items, id, 'request.txt'), 'utf8').trim();
  const row = { run_id: r.run_id, recorded_exit: r.exit_code, request_matches_manifest: request === m.request };
  const rx = RX.extractExamples(request);
  // The staged path's KAN-107 stop before any model call (intent/staged.js): a change with no stated behaviour.
  row.request_examples = { supported: rx.examples.length, unsupported: rx.unsupported.length, underspecified: rx.underspecified.map((u) => u.excerpt) };
  if (!m.contract_hash) { row.contract = null; out.items[id] = row; continue; }
  const buf = fs.readFileSync(path.join(dir, 'artifacts', `${m.contract_hash}.json`));
  row.contract_sha256_ok = sha(buf) === m.contract_hash;
  const c = JSON.parse(buf);
  const verdict = (s) => (s.state === 'invalid' ? { state: s.state, errors: s.errors } : { state: s.state });
  row.recorded = verdict(contractState(JSON.parse(JSON.stringify(c))));
  const g = contractGrounding(groundApi(path.join(items, id, 'base'), m.request));
  row.regrounded = verdict(contractState({ ...JSON.parse(JSON.stringify(c)), api_grounding: g }));
  out.items[id] = row;
}

const text = JSON.stringify(out, null, 2) + '\n';
const o = arg('--out');
if (o) fs.writeFileSync(o, text); else process.stdout.write(text);
