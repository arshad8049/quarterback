// KAN-114 10689: freeze v7 integrity, the v6 correction sidecar, and the public-record scan on a SIMULATED v7 record.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const M = (f) => path.join(ROOT, 'bench/opus-pilot/mocha', f);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('freeze v7 (kept, superseded by v8): files not changed by v8 still match; v6 is kept', () => {
  const v7 = JSON.parse(fs.readFileSync(M('pair-5892-freeze-v7.json'), 'utf8'));
  const v6 = JSON.parse(fs.readFileSync(M('pair-5892-freeze-v6.json'), 'utf8'));
  const v8 = JSON.parse(fs.readFileSync(M('pair-5892-freeze-v8.json'), 'utf8'));
  assert.equal(v7.version, 'pair-5892-freeze-v7'); assert.equal(v6.version, 'pair-5892-freeze-v6');
  assert.match(v7.supersedes, /^pair-5892-freeze-v6/); assert.match(v7.approved_by, /10689/);
  const drift = Object.entries(v7.files).filter(([f, h]) => sha(fs.readFileSync(path.join(ROOT, f))) !== h).map(([f]) => f);
  assert.deepEqual(drift.sort(), [...v8.changed_from_v7].sort(), 'v7 drifts only in the files v8 records as changed');
  assert.deepEqual(Object.keys(v7.files).sort(), Object.keys(v6.files).sort(), 'same frozen file set as v6');
  assert.deepEqual(v7.shared.images, v6.shared.images); assert.equal(v7.shared.base_commit, v6.shared.base_commit);
  assert.equal(v7.arm_a.briefing_sha256, v6.arm_a.briefing_sha256); assert.equal(v7.arm_b.contract_sha256, v6.arm_b.contract_sha256);
});

test('freeze v8: every frozen file matches; same file set, images, base, briefing and contract as v7; the driver uses v8', () => {
  const v7 = JSON.parse(fs.readFileSync(M('pair-5892-freeze-v7.json'), 'utf8'));
  const v8 = JSON.parse(fs.readFileSync(M('pair-5892-freeze-v8.json'), 'utf8'));
  assert.equal(v8.version, 'pair-5892-freeze-v8'); assert.match(v8.supersedes, /^pair-5892-freeze-v7/); assert.match(v8.approved_by, /10693/);
  const drift = Object.entries(v8.files).filter(([f, h]) => sha(fs.readFileSync(path.join(ROOT, f))) !== h).map(([f]) => f);
  assert.deepEqual(drift, []);
  assert.deepEqual(Object.keys(v8.files).sort(), Object.keys(v7.files).sort());
  assert.deepEqual(v8.shared, v7.shared); assert.deepEqual(v8.arm_a, v7.arm_a); assert.deepEqual(v8.arm_b, v7.arm_b);
  assert.deepEqual([...v8.changed_from_v7].sort(), ['bench/opus-pilot/pair.mjs', 'lib/pilot/pair.js']);
  assert.match(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/pair.mjs'), 'utf8'), /pair-5892-freeze-v8\.json/);
});

test('v6 correction sidecar: run 44146278864 is NOT a verified pair; originals untouched; B never reconstructed', () => {
  const c = JSON.parse(fs.readFileSync(M('pair-5892-v6-corrections.json'), 'utf8'));
  assert.equal(c.applies_to.workflow_run, '44146278864'); assert.equal(c.applies_to.freeze, 'pair-5892-freeze-v6');
  assert.match(c.review, /10689/); assert.match(c.determination, /NOT a verified paired comparison/);
  assert.match(c.retained.arm_b.model_billing, /PERMANENTLY UNVERIFIED/);
  assert.ok(!('served_model' in c.retained.arm_b), 'no served model is reconstructed for B');
});

test('a SIMULATED v7 record passes the public scan (no secret pattern, no diff text) and still carries its label', () => {
  const A = require('../../lib/pilot/arm-a');
  const PAIR = require('../../lib/pilot/pair');
  const entry = { attempt: 1, outcome: 'verified', flags: ['verified'], reasons: [], evidence_complete: true, requested_model: 'claude-opus-5-5', served_model: 'claude-opus-5-5', cli: '2.1.322',
    provider: 'firstParty', api_key_source: 'none', is_using_overage: false, overage_status: 'disabled', agent_stage_ms: 1, patch_sha256: sha('x') };
  const res = { pilot: { primary: 'execution_verified', flags: ['execution_verified'], reasons: [], patch_use: 'grade_under_10583', valid_completed_trial: true, effort: { coding_ms: 1, total_elapsed_ms: 2 } },
    profile: { model: 'claude-opus-5-5', claude_code_version: '2.1.322' }, attempt_evidence: [entry], evidence: { verified: true, problems: [] },
    agent_report: { model: { requested: 'claude-opus-5-5', served: 'claude-opus-5-5' }, billing_route: { api_key_source: 'none', provider: 'firstParty', is_using_overage: false } },
    candidate: { sha256: sha('x'), bytes: 1, gradable: true, files: [] }, patch: Buffer.from('x'), attempts: 1, coding_ms: 1800000, total_ms: 5400000 };
  const s = PAIR.pairSummary(res, { arm: 'B', mode: 'task', live: false, simulated: true, freeze: 'pair-5892-freeze-v7', task: 'axios-x', taskId: 'qbt_x' });
  assert.deepEqual(A.scanText(JSON.stringify(s), { kind: 'public' }).refused, []);
  assert.match(s.evidence_label, /^SIMULATED/);
  assert.deepEqual(PAIR.recordProblems(JSON.parse(JSON.stringify(s)), { patchBytes: Buffer.from('x') }), []);
});
