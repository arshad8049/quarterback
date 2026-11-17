// KAN-114 10693 (freeze v8): three record-integrity gates on top of v7.
//  1. the serialized readback is an ENFORCEMENT gate in live modes (nonzero refusal, no grading eligibility), and dry /
//     simulated modes assert their expected outcome instead of masquerading as live evidence;
//  2. exactly one evidence entry per executed attempt, unique ordered attempt ids, valid patch hashes, and the final
//     attempt's patch hash linked to the candidate hash AND the actual captured bytes;
//  3. missing/invalid evidence removes verified-comparison grading eligibility for EVERY primary (coding_timeout
//     included) while keeping the original classification.
// All streams are SIMULATED (bench/opus-pilot/sim/pair-sim-fixture.js): no Docker, model, network or token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PAIR = require('../../lib/pilot/pair');
const F = require('../../bench/opus-pilot/sim/pair-sim-fixture');
const PROFILE = { model: F.MODEL, claude_code_version: '2.1.322' };

const entry = (attempt, extra = {}) => ({ attempt, outcome: 'verified', flags: ['verified'], reasons: [], evidence_complete: true, requested_model: F.MODEL, served_model: F.MODEL,
  cli: '2.1.322', provider: 'firstParty', api_key_source: 'none', is_using_overage: false, overage_status: 'disabled', agent_stage_ms: 1, patch_sha256: F.sha(F.patchN(attempt)), ...extra });
function serialize(summary) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pairv8-pub-')), 'pair.json');
  fs.writeFileSync(f, `${JSON.stringify(summary, null, 2)}\n`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const ctx = (arm, extra = {}) => ({ ...F.SIM_CTX, arm, ...extra });

// ── 2. entry count / identity / patch-hash linkage ──
test('v8 evidence: exactly one entry per executed attempt (missing, extra and duplicate entries refused)', () => {
  assert.deepEqual(PAIR.evidenceProblems([entry(1), entry(2)], PROFILE, 2), []);
  assert.ok(PAIR.evidenceProblems([entry(1)], PROFILE, 2).some((p) => /1 evidence entr.* for 2 executed attempt/.test(p)), 'missing');
  assert.ok(PAIR.evidenceProblems([entry(1), entry(2), entry(3)], PROFILE, 2).some((p) => /3 evidence entr.* for 2 executed attempt/.test(p)), 'extra');
  assert.ok(PAIR.evidenceProblems([entry(1), entry(1)], PROFILE, 2).some((p) => /attempt ids/.test(p)), 'duplicate');
  assert.ok(PAIR.evidenceProblems([entry(2), entry(1)], PROFILE, 2).some((p) => /attempt ids/.test(p)), 'out of order');
  assert.ok(PAIR.evidenceProblems([entry(1)], PROFILE, undefined).some((p) => /executed attempt count/.test(p)), 'unknown attempt count');
});

test('v8 evidence: patch hashes must be valid sha256 hex (or null for an attempt that captured no patch)', () => {
  assert.deepEqual(PAIR.evidenceProblems([entry(1, { patch_sha256: null })], PROFILE, 1), []);
  assert.ok(PAIR.evidenceProblems([entry(1, { patch_sha256: 'zz' })], PROFILE, 1).some((p) => /patch hash/.test(p)));
  assert.ok(PAIR.evidenceProblems([entry(1, { patch_sha256: 'A'.repeat(64) })], PROFILE, 1).some((p) => /patch hash/.test(p)));
});

test('v8 linkage: the final attempt hash = candidate hash = sha256 of the ACTUAL captured bytes (stored fields alone are not linkage)', async () => {
  const res = await PAIR.runArmB(F.baseB({ seam: F.fakeSandbox([], { passOn: 2 }) }));
  assert.equal(res.attempts, 2);
  const back = serialize(PAIR.pairSummary(res, ctx('B')));
  assert.deepEqual(PAIR.recordProblems(back, { patchBytes: res.patch }), []);
  assert.equal(back.attempt_evidence[1].patch_sha256, back.candidate.sha256);
  // swapped final hash (attempt 1's hash in the final slot)
  const swapped = JSON.parse(JSON.stringify(back)); swapped.attempt_evidence[1].patch_sha256 = back.attempt_evidence[0].patch_sha256;
  assert.ok(PAIR.recordProblems(swapped, { patchBytes: res.patch }).some((p) => /final attempt patch/.test(p)));
  // record self-consistent but the bytes in hand differ
  assert.ok(PAIR.recordProblems(back, { patchBytes: Buffer.from(F.patchN(1)) }).some((p) => /captured bytes/.test(p)));
  // bytes not supplied: linkage is NOT considered checked
  assert.ok(PAIR.recordProblems(back).some((p) => /captured bytes not supplied/.test(p)));
});

// ── 3. grading eligibility for every primary ──
function timeoutRes(entries) {
  return { pilot: { primary: 'coding_timeout', flags: ['coding_timeout'], reasons: [], patch_use: 'grade_under_10583', valid_completed_trial: true, effort: { coding_ms: 1800000, total_elapsed_ms: 1900000 } },
    profile: { ...PROFILE }, candidate: { sha256: F.sha(F.patchN(1)), bytes: F.patchN(1).length, gradable: true, files: [] }, patch: Buffer.from(F.patchN(1)),
    grade_now: true, stop_batch: false, attempts: 1, coding_ms: 1800000, total_ms: 5400000, _records: entries };
}
const rec = (outcome, extra = {}) => ({ attempt: 1, outcome, flags: [outcome], reasons: [], evidence_complete: true, sandbox_state: 'timeout', agent_stage_ms: 1800000, patch_sha256: F.sha(F.patchN(1)),
  report: { model: { requested: F.MODEL, served: F.MODEL }, claude_code_version: '2.1.322', billing_route: { provider: 'firstParty', api_key_source: 'none', is_using_overage: false, overage_status: 'disabled' } }, ...extra });

test('v8: a coding_timeout with MISSING evidence keeps its classification but loses grading eligibility and valid_completed_trial', () => {
  const r = timeoutRes(); const out = PAIR.applyEvidence(r, [rec('coding_timeout', { evidence_complete: false, report: {} })], 1, null, { liveEvidenceGate: true });
  assert.equal(out.pilot.primary, 'coding_timeout', 'the original timeout classification is preserved');
  assert.equal(out.pilot.valid_completed_trial, false);
  assert.notEqual(out.pilot.patch_use, 'grade_under_10583');
  assert.equal(out.grade_now, false);
  assert.equal(out.pilot.execution_evidence, 'not_verified');
  assert.equal(out.evidence.verified, false);
});

test('v8: a coding_timeout with COMPLETE evidence keeps the predeclared grading rule', () => {
  const out = PAIR.applyEvidence(timeoutRes(), [rec('coding_timeout')], 1, null, { liveEvidenceGate: true });
  assert.equal(out.evidence.verified, true);
  assert.equal(out.pilot.primary, 'coding_timeout');
  assert.equal(out.pilot.patch_use, 'grade_under_10583');
  assert.equal(out.grade_now, true);
});

test('v8: every other non-verified primary also loses eligibility when evidence is missing (infra_interruption kept as is)', () => {
  const r = timeoutRes(); r.pilot = { ...r.pilot, primary: 'infra_interruption', flags: ['infra_interruption'] };
  const out = PAIR.applyEvidence(r, [], 1, null, { liveEvidenceGate: true });
  assert.equal(out.pilot.primary, 'infra_interruption');
  assert.equal(out.pilot.valid_completed_trial, false);
  assert.notEqual(out.pilot.patch_use, 'grade_under_10583');
  assert.equal(out.grade_now, false);
});

// ── 1. readback as an enforcement gate ──
test('v8 live gate: an otherwise-good result whose SERIALIZED record is invalid is refused nonzero and is not grade-eligible', async () => {
  const res = await PAIR.runArmB(F.baseB({ seam: F.fakeSandbox([], { passOn: 1 }), liveEvidenceGate: true }));
  assert.equal(res.pilot.primary, 'execution_verified');
  const live = { ...ctx('B'), live: true, simulated: false };
  const good = serialize(PAIR.pairSummary(res, live));
  assert.equal(PAIR.readbackGate({ mode: 'task', record: good, patchBytes: res.patch, stopBatch: false }).code, 0);
  const bad = JSON.parse(JSON.stringify(good)); bad.attempt_evidence[0].served_model = 'claude-sonnet-5-5';   // invalid after serialization
  const g = PAIR.readbackGate({ mode: 'task', record: bad, patchBytes: res.patch, stopBatch: false });
  assert.notEqual(g.code, 0); assert.equal(g.verified, false); assert.ok(g.problems.length > 0);
  assert.equal(g.sidecar.verified_artifact, false, 'diagnostic evidence is preserved but never called verified');
  assert.equal(g.sidecar.grade_eligible, false);
  // the smoke path uses the same readback (not the earlier in-memory summary)
  assert.notEqual(PAIR.readbackGate({ mode: 'smoke', record: bad, patchBytes: res.patch, stopBatch: false }).code, 0);
});

test('v8 live gate: a SIMULATED or DRY-RUN labelled record can never pass a live mode (no reachable bypass)', async () => {
  const res = await PAIR.runArmB(F.baseB({ seam: F.fakeSandbox([], { passOn: 1 }) }));
  const sim = serialize(PAIR.pairSummary(res, ctx('B')));
  assert.deepEqual(PAIR.recordProblems(sim, { patchBytes: res.patch }), [], 'valid as a simulated record');
  const g = PAIR.readbackGate({ mode: 'task', record: sim, patchBytes: res.patch, stopBatch: false });
  assert.notEqual(g.code, 0); assert.ok(g.problems.some((p) => /not a live record/.test(p)));
  const dry = serialize(PAIR.pairSummary(res, ctx('B', { simulated: false })));
  assert.notEqual(PAIR.readbackGate({ mode: 'smoke', record: dry, patchBytes: res.patch, stopBatch: false }).code, 0);
});

test('v8 dry gate: a scripted dry run without a stream must remain UNVERIFIED (expected, exit 0); a dry record that verifies is a failure', async () => {
  const res = await PAIR.runArmA(F.baseA({ seam: F.armASeam({ stdout: '' }) }));
  const dry = serialize(PAIR.pairSummary(res, ctx('A', { simulated: false })));
  const g = PAIR.readbackGate({ mode: 'dry-run', record: dry, patchBytes: res.patch, stopBatch: res.stop_batch });
  assert.equal(g.code, 0); assert.equal(g.verified, false); assert.match(g.expectation, /unverified/);
  const ok = await PAIR.runArmA(F.baseA({ seam: F.armASeam() }));
  const masquerade = serialize(PAIR.pairSummary(ok, ctx('A', { simulated: false })));
  assert.notEqual(PAIR.readbackGate({ mode: 'dry-run', record: masquerade, patchBytes: ok.patch, stopBatch: false }).code, 0);
  // linkage is checked in dry runs too
  assert.notEqual(PAIR.readbackGate({ mode: 'dry-run', record: dry, patchBytes: Buffer.from('other'), stopBatch: false }).code, 0);
});

test('v8 driver: pair.mjs exits through readbackGate on the PUBLISHED record, writes the readback sidecar, and uses freeze v8', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/pair.mjs'), 'utf8');
  assert.match(src, /PAIR\.readbackGate\(/);
  assert.match(src, /readback-\$\{arm\}\.json/);
  assert.match(src, /pair-5892-freeze-v8\.json/);
  assert.doesNotMatch(src, /process\.exit\(res\.stop_batch/, 'the exit no longer ignores the readback');
});

test('v8 rehearsal workflow: branch-only, no environment, no secret, no live flag; simulation refuses any credential or live flag', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/pair-5892-v8-rehearsal.yml'), 'utf8');
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /secrets\./); assert.doesNotMatch(code, /^\s*environment:/m); assert.doesNotMatch(code, /PAIR_LIVE|ARM_A_LIVE|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(code, /branches: \[pair-5892-v7\]/); assert.doesNotMatch(code, /kan117-axios-mocha|opus-arm-a/);
  assert.match(code, /--mode=dry-run/); assert.doesNotMatch(code, /--mode=(task|smoke)\b/);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/opus-pilot/sim/pair-sim.mjs'), '--write', `--out=${fs.mkdtempSync(path.join(os.tmpdir(), 'pairv8-sim-'))}`],
    { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'dummy-not-a-token' }, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stdout, /refusing: CLAUDE_CODE_OAUTH_TOKEN is set/);
});

test('v8 SIMULATED artifact path: write -> separate readback process verifies the valid sequences, refuses missing evidence, live gate refuses all', () => {
  const { spawnSync } = require('node:child_process');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pairv8-simrb-'));
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(PAIR_LIVE|ARM_A_LIVE|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_|CLAUDE_API)/.test(k)) delete env[k];
  const w = spawnSync(process.execPath, [path.join(ROOT, 'bench/opus-pilot/sim/pair-sim.mjs'), '--write', `--out=${d}`], { env, encoding: 'utf8' });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/opus-pilot/sim/pair-sim.mjs'), '--readback', `--in=${d}`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/live_gate=8/g) || []).length, 3);
  // tampering with the transferred bytes breaks the readback
  fs.writeFileSync(path.join(d, 'a-complete.diff'), 'tampered\n');
  assert.notEqual(spawnSync(process.execPath, [path.join(ROOT, 'bench/opus-pilot/sim/pair-sim.mjs'), '--readback', `--in=${d}`], { env, encoding: 'utf8' }).status, 0);
});
