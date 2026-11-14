// KAN-117 review 10609: the narrow handoff for a first task-2005 exploratory run.
//   - a clean agent input bundle (agent-store fields only, leak-checked, the same briefing for every arm)
//   - a captured-candidate record + the pinned grading entrypoint for ARBITRARY captured patches
//   - image provenance (base digests, layer-chain proof, saved-bundle hashes, load verification)
//   - the same-environment launch specification with explicit KAN-112 / KAN-113 dependencies
// Everything here is fake: no Docker, no model, no network, no real grader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENV = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/task-2005.env.json'), 'utf8'));
const E = require('../../lib/research/dataset-env');
const B = require('../../lib/research/agent-bundle');
const C = require('../../lib/research/candidate');
const P = require('../../lib/research/image-provenance');
const L = require('../../lib/research/launch-spec');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── fixtures (synthetic; never the real task text) ──
const PROBLEM = 'Map.merge drops keys when the argument is a Record with defaults. Expected merge to keep every key.';
const agentRow = { task_id: ENV.task_id, problem_statement: PROBLEM };
const controllerRow = { task_id: ENV.task_id, repo: 'immutable-js/immutable-js', base_commit: '77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6', instance_id: 'immutable-js__immutable-js-2005' };
const GOLD = 'diff --git a/src/Map.js b/src/Map.js\n--- a/src/Map.js\n+++ b/src/Map.js\n@@ -1,1 +1,2 @@\n x\n+  return mergeIntoKeyedWith(this, iters, recordDefaultsAware);\n';
const TESTP = 'diff --git a/__tests__/Merge.ts b/__tests__/Merge.ts\n+++ b/__tests__/Merge.ts\n@@ -0,0 +1 @@\n+  expect(merged.toObject()).toEqual({ alpha: 1, beta: 2 });\n';
const vaultRow = { task_id: ENV.task_id, patch: GOLD, test_patch: TESTP, FAIL_TO_PASS: JSON.stringify(['merge keeps record default keys']), PASS_TO_PASS: ['Map has keys'] };

// ── agent bundle ──
test('the agent bundle holds agent-store fields only, and every arm gets the same effective briefing', () => {
  const { bundle } = B.buildAgentBundle({ agentRow, controllerRow, vaultRow, env: ENV });
  assert.equal(bundle.schema, 'qb-kan117-agent-bundle/1');
  assert.equal(bundle.briefing, PROBLEM);
  assert.deepEqual(bundle.fields_shown, ['problem_statement']);
  for (const k of ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'instance_id']) assert.ok(bundle.fields_withheld.includes(k), k);
  assert.equal(bundle.repo.base_commit, controllerRow.base_commit);
  assert.equal(bundle.briefing_sha256, sha(PROBLEM));
  // the pipeline appends the notice with the same function the bundle hashes
  assert.equal(E.researchBriefing(PROBLEM, ENV), `${PROBLEM}\n\n${E.agentNotice(ENV)}`);
  assert.equal(bundle.effective_briefing_sha256, sha(E.researchBriefing(PROBLEM, ENV)));
  assert.equal(bundle.arms, 'identical for every arm');
  const json = JSON.stringify(bundle);
  for (const secret of ['mergeIntoKeyedWith', 'merge keeps record default keys', 'toEqual({ alpha', 'immutable-js__immutable-js-2005']) assert.ok(!json.includes(secret), secret);
});

test('the agent bundle refuses a briefing that leaks a required test name, gold lines or test-patch lines (counts only, no text)', () => {
  const cases = [
    ['required_test_name', `${PROBLEM}\nSee merge keeps record default keys.`],
    ['gold_patch_line', `${PROBLEM}\nreturn mergeIntoKeyedWith(this, iters, recordDefaultsAware);`],
    ['test_patch_line', `${PROBLEM}\nexpect(merged.toObject()).toEqual({ alpha: 1, beta: 2 });`],
  ];
  for (const [kind, text] of cases) {
    assert.throws(() => B.buildAgentBundle({ agentRow: { ...agentRow, problem_statement: text }, controllerRow, vaultRow, env: ENV }), (e) => {
      assert.match(e.message, new RegExp(`agent bundle: leak check failed: .*${kind}`));
      assert.ok(!e.message.includes('mergeIntoKeyedWith') && !e.message.includes('alpha'), 'the error carries no leaked text');
      return true;
    });
  }
});

test('the agent bundle refuses mismatched task ids, a missing problem statement and a wrong base', () => {
  assert.throws(() => B.buildAgentBundle({ agentRow: { ...agentRow, task_id: 'qbt_000000000000' }, controllerRow, vaultRow, env: ENV }), /task id/);
  assert.throws(() => B.buildAgentBundle({ agentRow: { task_id: ENV.task_id }, controllerRow, vaultRow, env: ENV }), /problem_statement/);
  assert.throws(() => B.buildAgentBundle({ agentRow, controllerRow: { ...controllerRow, base_commit: 'abc' }, vaultRow, env: ENV }), /base_commit/);
});

// ── candidate record ──
const run = (o = {}) => ({
  status: o.status || 'completed', reason: null,
  patch_raw: o.patch === undefined ? Buffer.from('diff --git a/NOTES.md b/NOTES.md\n') : o.patch,
  base_tree: 'b'.repeat(40), candidate_tree: 'c'.repeat(40), changes: o.changes || [{ file: 'NOTES.md', status: 'A' }],
  sandbox: { capture: { verdict: { state: o.capture || 'captured' }, ...(o.refused ? { policy_refused: { rule: 'generated_paths', findings: [{ file: 'dist/x.js', status: 'A', kind: 'new_untracked' }] }, unresolved: 'generated_paths_refused' } : {}) },
    verification: o.refused ? { mode: 'research_jest', status: 'not_run', reason: 'capture_policy_refused' } : { mode: 'research_jest', verdict: 'passed' } },
});

test('a cleanly captured candidate is gradable and its record carries the exact bytes hash, trees and internal verdict', () => {
  const r = run();
  const rec = C.candidateRecord(r, { label: 'notes', env: ENV, qbCommit: 'q'.repeat(40) });
  assert.equal(rec.schema, 'qb-kan117-candidate/1');
  assert.deepEqual([rec.gradable, rec.not_gradable_reason], [true, null]);
  assert.equal(rec.sha256, sha(r.patch_raw)); assert.equal(rec.bytes, r.patch_raw.length);
  assert.deepEqual([rec.task_id, rec.grader_task, rec.base_tree, rec.candidate_tree], [ENV.task_id, '2005', r.base_tree, r.candidate_tree]);
  assert.equal(rec.internal.verdict, 'passed');
  assert.equal(rec.patch_use, 'decided by the KAN-112 trial classification, not by this record');
  assert.doesNotThrow(() => C.checkCandidate(rec, r.patch_raw, ENV));
});

test('an empty (no_change) capture is gradable as an empty candidate; a timed-out run with a clean capture is still gradable', () => {
  const e = C.candidateRecord(run({ status: 'no_change', capture: 'no_change', patch: null, changes: [] }), { label: 'empty', env: ENV });
  assert.deepEqual([e.gradable, e.bytes, e.sha256], [true, 0, sha('')]);
  const t = C.candidateRecord(run({ status: 'timeout' }), { label: 'late', env: ENV });
  assert.deepEqual([t.gradable, t.run_status], [true, 'timeout']);
});

test('policy-refused, unresolved or errored captures are NOT gradable, with the reason recorded and the raw hash kept', () => {
  const r = run({ refused: true, changes: [{ file: 'dist/x.js', status: 'A' }] });
  const rec = C.candidateRecord(r, { label: 'gen', env: ENV });
  assert.deepEqual([rec.gradable, rec.not_gradable_reason], [false, 'capture_policy_refused']);
  assert.equal(rec.sha256, sha(r.patch_raw), 'the rejected raw patch stays as evidence');
  assert.deepEqual(rec.policy_refused.findings.map((f) => f.kind), ['new_untracked']);
  assert.equal(C.candidateRecord(run({ capture: 'unresolved' }), { label: 'u', env: ENV }).not_gradable_reason, 'capture_unresolved');
  assert.equal(C.candidateRecord({ ...run(), status: 'infra_error', sandbox: {} }, { label: 'i', env: ENV }).not_gradable_reason, 'no_capture');
});

test('checkCandidate refuses different bytes, another task and malformed labels', () => {
  const r = run();
  const rec = C.candidateRecord(r, { label: 'notes', env: ENV });
  assert.throws(() => C.checkCandidate(rec, Buffer.from('other'), ENV), /sha256/);
  assert.throws(() => C.checkCandidate({ ...rec, task_id: 'qbt_00b20b1b0285' }, r.patch_raw, ENV), /task/);
  assert.throws(() => C.candidateRecord(r, { label: 'Bad Label', env: ENV }), /label/);
});

// ── the pinned grading entrypoint (with a fake grade script; the real grade.mjs candidate mode has its own tests) ──
const ENTRY = path.join(ROOT, 'bench/public/kan117/grade-candidate.mjs');
function entry({ rec, diff, fakeOut = 'ok', env = {} }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan117h-'));
  fs.writeFileSync(path.join(d, 'rec.json'), JSON.stringify(rec)); fs.writeFileSync(path.join(d, 'c.diff'), diff);
  const fake = path.join(d, 'fake-grade.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs'; import crypto from 'node:crypto';
const a = Object.fromEntries(process.argv.slice(2).map((x) => { const i = x.indexOf('='); return i < 0 ? [x, true] : [x.slice(0, i), x.slice(i + 1)]; }));
fs.writeFileSync(${JSON.stringify(path.join(d, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
const h = ${JSON.stringify(fakeOut)} === 'wrong' ? 'f'.repeat(64) : crypto.createHash('sha256').update(fs.readFileSync(a['--candidate'])).digest('hex');
fs.mkdirSync(a['--out'], { recursive: true });
fs.writeFileSync(a['--out'] + '/candidate-' + a['--label'] + '.json', JSON.stringify({ candidate: { file_sha256: h }, expected_outcome: null, run: { outcome: 'graded' } }));
process.exit(${JSON.stringify(fakeOut)} === 'invalid' ? 3 : 0);`);
  const r = spawnSync(process.execPath, [ENTRY, `--record=${path.join(d, 'rec.json')}`, `--diff=${path.join(d, 'c.diff')}`, `--out=${path.join(d, 'out')}`],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: '', KAN117_CI_RUN: '', QB_KAN117_TEST_GRADER: fake, ...env } });
  const argv = fs.existsSync(path.join(d, 'argv.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'argv.json'), 'utf8')) : null;
  const ng = path.join(d, 'out', `not-graded-${rec.label}.json`);
  const notGraded = fs.existsSync(ng) ? JSON.parse(fs.readFileSync(ng, 'utf8')) : null;
  fs.rmSync(d, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr, argv, notGraded };
}

test('the entrypoint grades an arbitrary captured candidate with the pinned grader args and the approvals.json citation', () => {
  const r = run(); const rec = C.candidateRecord(r, { label: 'notes', env: ENV });
  const x = entry({ rec, diff: r.patch_raw });
  assert.equal(x.status, 0, x.stderr);
  const approvals = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/approvals.json'), 'utf8'));
  for (const a of ['--execute', `--approved-by=${approvals.candidate_grade.approval_comment_id}`, '--variant=A1', '--task=2005', '--label=notes']) assert.ok(x.argv.includes(a), a);
});

test('the entrypoint refuses changed bytes before grading, and records a not-gradable candidate without grading it (exit 4)', () => {
  const r = run(); const rec = C.candidateRecord(r, { label: 'notes', env: ENV });
  const bad = entry({ rec, diff: Buffer.from('tampered') });
  assert.equal(bad.status, 2); assert.equal(bad.argv, null); assert.match(bad.stderr, /sha256/);
  const g = run({ refused: true }); const grec = C.candidateRecord(g, { label: 'gen', env: ENV });
  const x = entry({ rec: grec, diff: g.patch_raw });
  assert.equal(x.status, 4); assert.equal(x.argv, null, 'the grader never ran');
  assert.equal(x.notGraded.reason, 'capture_policy_refused');
});

test('the entrypoint fails if the grader graded different bytes, passes grader invalid outcomes through, and ignores the test grader in CI', () => {
  const r = run(); const rec = C.candidateRecord(r, { label: 'notes', env: ENV });
  assert.equal(entry({ rec, diff: r.patch_raw, fakeOut: 'wrong' }).status, 1);
  assert.equal(entry({ rec, diff: r.patch_raw, fakeOut: 'invalid' }).status, 3);
  const ci = entry({ rec, diff: r.patch_raw, env: { GITHUB_ACTIONS: 'true' } });
  assert.notEqual(ci.status, 0); assert.equal(ci.argv, null, 'a test grader is never honoured in CI');
});

// ── image provenance ──
const L3 = ['sha256:l1', 'sha256:l2', 'sha256:l3'];
test('the layer-chain check proves an image was built FROM the recorded base digest', () => {
  assert.equal(P.builtFrom(L3.slice(0, 2), L3), true);
  assert.equal(P.builtFrom(['sha256:l1', 'sha256:zz'], L3), false);
  assert.equal(P.builtFrom([], L3), false);
});

const prov = () => P.provenanceRecord({
  qbCommit: 'q'.repeat(40), claudeVersion: '2.1.322', docker: { server: '28.0.0' },
  bases: { agent: { ref: 'node:24-bookworm-slim', digest: 'node@sha256:' + 'a'.repeat(64), id: 'sha256:' + '1'.repeat(64), layers: L3.slice(0, 1) } },
  images: { agent: { ref: 'qb-sandbox-agent:c-0123456789abcdef', id: 'sha256:' + '2'.repeat(64), layers: L3, tar: 'agent.tar.gz', tar_sha256: 'd'.repeat(64), tar_bytes: 10 } },
  dockerfiles: { agent: 'e'.repeat(64) },
});
test('the provenance record names base digests, the built-from proof, image ids and saved-bundle hashes; refuses a mutable-only base', () => {
  const p = prov();
  assert.equal(p.schema, 'qb-kan117-image-provenance/1');
  assert.equal(p.images.agent.built_from_base, true);
  assert.equal(p.images.agent.base_digest, 'node@sha256:' + 'a'.repeat(64));
  assert.throws(() => P.provenanceRecord({ ...prov(), bases: { agent: { ref: 'node:24-bookworm-slim', digest: null, id: 'sha256:' + '1'.repeat(64), layers: [] } } }), /digest/);
});

test('load verification: the loaded image ids must equal the recorded ids, and each tar must match its hash', () => {
  const p = prov();
  assert.deepEqual(P.verifyLoaded(p, { agent: { id: p.images.agent.id, tar_sha256: 'd'.repeat(64) } }), []);
  assert.match(P.verifyLoaded(p, { agent: { id: 'sha256:' + '9'.repeat(64), tar_sha256: 'd'.repeat(64) } }).join(), /agent: loaded id/);
  assert.match(P.verifyLoaded(p, { agent: { id: p.images.agent.id, tar_sha256: '0'.repeat(64) } }).join(), /agent: tar sha256/);
  assert.match(P.verifyLoaded(p, {}).join(), /agent: not loaded/);
});

// ── launch specification ──
test('the launch spec gives both arms the same images, env, bundle and caps, and lists the open KAN-112/KAN-113 dependencies', () => {
  const { bundle } = B.buildAgentBundle({ agentRow, controllerRow, vaultRow, env: ENV });
  const amendment = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/amendments/amendment-1.json'), 'utf8'));
  const pilot = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/pilot-config.json'), 'utf8'));
  const s = L.launchSpec({ provenance: prov(), env: ENV, envSha256: 'e'.repeat(64), bundle, amendment, pilot, qbCommit: 'q'.repeat(40) });
  assert.equal(s.schema, 'qb-kan117-launch-spec/1');
  assert.deepEqual(Object.keys(s.arms), ['A', 'B']);
  const shared = (a) => JSON.stringify({ images: a.images, env: a.task_env_sha256, b: a.effective_briefing_sha256, total: a.trial_total_s, coding: a.coding_s, cap: a.internal_stage_cap_ms });
  assert.equal(shared(s.arms.A), shared(s.arms.B));
  assert.deepEqual([s.arms.A.max_attempts, s.arms.B.max_attempts], [1, 3]);
  assert.deepEqual([s.arms.A.trial_total_s, s.arms.A.coding_s], [5400, 1800]);
  assert.deepEqual(s.dependencies.map((d) => d.card), ['KAN-112', 'KAN-112', 'KAN-113']);
  assert.ok(s.dependencies.every((d) => d.status === 'open'));
  assert.equal(s.live_authorized, false);
  assert.match(s.not_exercised.join(' '), /contract\/repair/);
});
