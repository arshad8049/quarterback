/**
 * KAN-112 review 10603: amendment 1 enforced in the REAL experiment control flow
 * (runExperiment → runArm → agent/runner → grader → recordTrial → report), with a FAKE agent (sandbox seam)
 * and a FAKE sign-in adapter. No Docker, no model, no credentials, no real sign-in.
 * timeScale (test seam, honoured only with the sandbox seam) shrinks the 90-min total and 10-min sign-in windows.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runExperiment, taskEntries, armDefinitions } = require('../../bench/experiment-run');
const { createExperiment, loadExperiment } = require('../../bench/experiment');
const { reportData } = require('../../bench/report');
const { GRADER_FILES } = require('../../bench/grader');
const { qualify } = require('../../bench/qualify');
const budget = require('../../lib/budget');
const S = require('../../bench/schemas');
const P = require('../../lib/sandbox/agent-profile');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture, IMPL } = require('../helpers/grading-fixture');

const ROOT = path.join(__dirname, '..', '..');
const AMD_REL = 'bench/opus-pilot/amendments/amendment-1.json';
const AMD_SHA = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, AMD_REL))).digest('hex');
const ROUTE = 'test-only-route';
const profile = () => ({ ...P.profileFromConfig(P.loadReviewed()), auth_route: ROUTE });
const SCALE = 0.001;   // total 5.4 s, sign-in 0.6 s (coding budget is never scaled)

const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s',
  required_behavior: ['formatDuration(30000) returns "30s"'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };
const PROBES = { git: (args) => Buffer.from(args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''), claudeVersion: () => 'unknown',
  agentVersion: () => 't', agentConfig: () => ({}), images: () => ({}), models: () => [], ensureImages: async () => {} };

const testReport = (pass) => [
  { type: 'qb:start', format: 'qb-node-test-events/1' },
  { type: pass ? 'test:pass' : 'test:fail', name: 'hidden', nesting: 0, path: [], file: '/verify/test/a.test.js', kind: 'test', skip: false, todo: false,
    ...(pass ? {} : { failureType: 'testCodeFailure', error: 'expected 30s' }) },
  { type: 'test:summary', file: null, counts: { tests: 1, passed: pass ? 1 : 0, failed: pass ? 0 : 1, cancelled: 0, skipped: 0, todo: 0 }, success: pass },
  { type: 'qb:end' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';
const verification = (pass) => ({ status: 'ran', state: pass ? 'completed' : 'execution_error', exit_code: pass ? 0 : 1, report: testReport(pass), report_error: null, output: '' });

/** Grader stand-in: passes when the patch installs the correct implementation; optionally waits for the deadline. */
const graderRunner = ({ hang = false } = {}) => async (o) => {
  if (hang) await new Promise((res) => { if (o.signal && o.signal.aborted) return res(); o.signal && o.signal.addEventListener('abort', res); });
  if (o.signal && o.signal.aborted) return { status: 'cancelled', reason: 'cancelled: deadline', changes: [], sandbox: { stages: {} } };
  const added = String(o.applyPatch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n') + '\n';
  const pass = added === IMPL.correct;
  return { status: 'completed', changes: [{ file: 'src/duration.js' }], sandbox: { stages: { agent: { exit_code: 0 } }, verification: verification(pass) } };
};

// Claude Code stream-json shape (observed field names; synthetic values; no fake-CLI marker: this is a test seam stream)
function stream({ rates = true } = {}) {
  const m = 'claude-opus-5-5';
  return [
    { type: 'system', subtype: 'init', model: m, apiKeySource: 'none', claude_code_version: '2.1.322' },
    { type: 'assistant', message: { model: m } },
    ...(rates ? [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false } }] : []),
    { type: 'result', subtype: 'success', modelUsage: { [m]: { provider: 'firstParty' } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
}

let tmp; const fixtures = [];
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan112ri-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });

/**
 * One pilot experiment (A and E, 1 repetition) through the real runner.
 * agent(o, ctx) → sandbox result; ctx = { f, calls }. Returns trials, pilot records, report data, calls, seen workspaces.
 */
async function experiment(label, { agent, signIn = async () => ({ status: 'ok' }), config = {}, budgetOver = {}, grader = graderRunner(), noAdapter = false, judge = { met: true }, timeScale = SCALE } = {}) {
  const f = gradingFixture(); fixtures.push(f);
  const q = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: graderRunner(), reference: f.patch('correct'),
    incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
  const spec = { ...f.spec, oracle: ORACLE, qualification: q };
  const pins = { qb: { commit: 'a'.repeat(40), dirty: false, dirty_patch_sha256: null }, agent: { name: 'claude-code', adapter_version: 't', cli_version: 'unknown' },
    images: {}, node: process.version, grader: { files: Object.fromEntries(GRADER_FILES.map((g) => [g, S.sha256File(path.join(ROOT, g))])) }, models: [] };
  const { dir } = createExperiment({ dir: path.join(tmp, label), kind: 'exploratory', tasks: taskEntries([spec]), arms: armDefinitions(['A', 'E']),
    primary_comparison: ['A', 'E'], budget: { agent_time_ms: 1_800_000, trial_deadline_ms: 5_400_000, model_call_deadline_ms: 30_000, total_compute_controlled: false, ...budgetOver },
    repetitions: 1, pins, memory: { starting_store_sha256: null },
    config: Object.fromEntries(Object.entries({ agent_profile: profile(), pilot_amendment: { path: AMD_REL, sha256: AMD_SHA }, ...config }).filter(([, v]) => v !== undefined)) });
  const calls = []; const seen = new Set();
  const runSandboxed = async (o) => { calls.push(o); seen.add(o.repoPath); return agent(o, { f, calls }); };
  const m = mockFetch(ollamaReply({ met: judge.met, evidence: 'checked', repair: 'Render whole seconds' }));
  let error = null; const keepAlive = setInterval(() => {}, 1000);   // the budget deadline timer is unref'd
  try {
    await runExperiment(dir, { specs: { [spec.id]: spec }, runSandboxed, runsDir: path.join(tmp, `${label}-runs`), preflight: { probes: PROBES },
      grader: { suitesRoot: f.suitesRoot, runSandboxed: grader }, approvedAuthRoutes: [ROUTE], timeScale,
      ...(noAdapter ? {} : { signInAdapter: signIn }) });
  } catch (e) { error = e; } finally { clearInterval(keepAlive); m.restore(); budget.endRun(); }
  const exp = loadExperiment(dir);
  const pilot = Object.fromEntries(exp.trials.filter((t) => t.artifacts['pilot.json']).map((t) => [t.arm, JSON.parse(fs.readFileSync(path.join(dir, t.artifacts['pilot.json'].path), 'utf8'))]));
  let report = null; try { report = reportData(dir); } catch (e) { report = { error: e.message }; }
  return { error, trials: exp.trials, pilot, report, calls, seen };
}

const ok = ({ f }, extra = {}) => ({ status: 'completed', diff: f.patch('correct'), changes: [{ file: 'src/duration.js', status: 'M', additions: 1, deletions: 1 }], unsupported_changes: [],
  agent_stdout: stream(), sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'completed', duration_ms: 1000 } }, verification: verification(true) }, ...extra });

describe('KAN-112 10603: both arms load and validate the pinned amendment', () => {
  test('A and E run end to end: execution_verified, graded as valid, slot/effort records consumed by the report', async () => {
    const r = await experiment('normal', { agent: (o, c) => ok(c), timeScale: 0.01 });
    assert.equal(r.error, null, r.error && r.error.message);
    assert.deepEqual(Object.keys(r.pilot).sort(), ['A', 'E']);
    for (const arm of ['A', 'E']) {
      const p = r.pilot[arm];
      assert.equal(p.amendment_sha256, AMD_SHA); assert.equal(p.primary, 'execution_verified', JSON.stringify(p)); assert.equal(p.valid_completed_trial, true);
      assert.equal(p.grade_use, 'valid'); assert.equal(p.grader_outcome, 'pass'); assert.ok(p.sign_ins >= 1); assert.ok('sign_in' in p.effort.human_ms);
      assert.equal(p.slot.pilot_arm, arm === 'E' ? 'B' : 'A');
    }
    assert.ok(!r.report.error, r.report.error);
    assert.deepEqual(r.report.pilot.slots, { assigned: 2, refused: 0, executed: 2, interrupted: 0, not_run: 0, execution_valid_pairs: 1, by_outcome: { execution_verified: 2 } });
    assert.equal(r.report.pilot.grades.valid, 2); assert.deepEqual(Object.keys(r.report.pilot.effort).sort(), ['A', 'E']);
  });
  for (const [why, over, re] of [
    ['no pinned amendment', { config: { pilot_amendment: undefined } }, /without a pinned KAN-112 amendment/],
    ['a tampered amendment (pin differs)', { config: { pilot_amendment: { path: AMD_REL, sha256: '0'.repeat(64) } } }, /differs from the pinned sha256/],
    ['a qualification-only setting in the live config', { config: { qualificationOnly: true } }, /qualification-only setting/],
    ['a budget that disagrees with the amendment', { budgetOver: { trial_deadline_ms: 7_200_000 } }, /trial_deadline_ms/],
    ['no sign-in adapter (no real sign-in exists)', { noAdapter: true }, /no approved sign-in implementation/],
  ]) {
    test(`refused before any arm-trial: ${why}`, async () => {
      const r = await experiment(`refuse-${why.replace(/\W+/g, '-')}`, { agent: (o, c) => ok(c), ...over });
      assert.ok(r.error, 'must refuse'); assert.match(r.error.message, re); assert.equal(r.calls.length, 0); assert.equal(r.trials.length, 0);
    });
  }
});

describe('KAN-112 10603: shared coding budget and the total clock at every stage', () => {
  test('arm E: attempts share the 1,800 s coding budget (each gets only what remains), recorded as coding effort', async () => {
    const r = await experiment('shared', { judge: { met: false }, timeScale: 0.01, agent: (o, c) => ok(c, { sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'completed', duration_ms: 600_000 } }, verification: verification(false) } }) });
    assert.equal(r.error, null, r.error && r.error.message);
    const e = r.pilot.E; const eCalls = r.calls.slice(1).map((c) => c.deadlines.agent);   // call 0 is arm A
    assert.ok(e.attempts.length >= 2 && e.attempts.length <= 3, `E attempts ${e.attempts.length}`);
    assert.deepEqual(eCalls, [1_800_000, 1_200_000, 600_000].slice(0, e.attempts.length), 'each attempt gets only what remains of ONE budget');
    assert.equal(e.effort.coding_ms, 600_000 * e.attempts.length, 'coding effort = the agent-stage time actually debited');
  });
  test('sign-in that outlasts its window is auth_timeout: no sandbox starts, nothing is graded, the workspace is cleaned', async () => {
    const r = await experiment('signin', { agent: (o, c) => ok(c), signIn: () => new Promise(() => {}) });
    assert.equal(r.error, null, r.error && r.error.message);
    for (const arm of ['A', 'E']) { assert.equal(r.pilot[arm].primary, 'auth_timeout'); assert.equal(r.pilot[arm].grade_use, 'not_graded'); assert.equal(r.pilot[arm].valid_completed_trial, false); }
    assert.equal(r.calls.length, 0);
    assert.equal(r.report.pilot.slots.interrupted, 2); assert.equal(r.report.pilot.slots.execution_valid_pairs, 0);
  });
  test('the total deadline during the agent stage is pipeline_total_timeout (stage agent), not infrastructure; cleanup runs', async () => {
    const r = await experiment('total-agent', { agent: (o) => new Promise((res) => {
      const done = () => res({ status: 'cancelled', reason: 'cancelled: trial deadline', diff: null, changes: [], unsupported_changes: [], sandbox: { stages: { agent: { state: 'cancelled' } } } });
      if (o.signal && o.signal.aborted) done(); else o.signal.addEventListener('abort', done); }) });
    assert.equal(r.error, null, r.error && r.error.message);
    for (const arm of ['A', 'E']) {
      const p = r.pilot[arm]; assert.equal(p.primary, 'pipeline_total_timeout', JSON.stringify(p)); assert.equal(p.cause.stage, 'agent');
      assert.ok(!p.flags.includes('infra_interruption')); assert.ok(p.effort.total_elapsed_ms >= 5_000, `total ${p.effort.total_elapsed_ms}`);
    }
    for (const d of r.seen) assert.equal(fs.existsSync(d), false, `workspace ${d} cleaned up`);
  });
  test('the total deadline during external grading is pipeline_total_timeout (stage grading); the grade is not a valid trial', async () => {
    const r = await experiment('total-grading', { agent: (o, c) => ok(c), grader: graderRunner({ hang: true }) });
    assert.equal(r.error, null, r.error && r.error.message);
    const p = r.pilot.A; assert.equal(p.primary, 'pipeline_total_timeout', JSON.stringify(p)); assert.equal(p.cause.stage, 'grading'); assert.equal(p.valid_completed_trial, false);
  });
});

describe('KAN-112 10603: outcomes, patches and flags are preserved', () => {
  const timedOut = (c, s = stream()) => ok(c, { status: 'timeout', agent_stdout: s, sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'timeout', duration_ms: 1_800_000 } }, verification: verification(true) } });
  test('coding_timeout keeps its captured patch and grades it under 10583 (valid grade)', async () => {
    const r = await experiment('coding-timeout', { agent: (o, c) => timedOut(c) });
    assert.equal(r.error, null, r.error && r.error.message);
    const p = r.pilot.A; assert.equal(p.primary, 'coding_timeout'); assert.equal(p.patch_use, 'grade_under_10583'); assert.equal(p.grade_use, 'valid'); assert.equal(p.grader_outcome, 'pass');
  });
  test('timeout + missing billing evidence: primary coding_timeout, both flags kept, never execution-valid evidence', async () => {
    const r = await experiment('timeout-incomplete', { agent: (o, c) => timedOut(c, stream({ rates: false })) });
    const p = r.pilot.A; assert.equal(p.primary, 'coding_timeout'); assert.ok(p.flags.includes('incomplete_evidence')); assert.equal(p.execution_evidence, 'not_verified');
  });
  test('incomplete execution evidence never becomes an execution-valid completed pair, and its patch is not graded', async () => {
    const r = await experiment('incomplete', { agent: (o, c) => ok(c, { agent_stdout: stream({ rates: false }) }) });
    assert.equal(r.error, null, r.error && r.error.message);
    for (const arm of ['A', 'E']) { const p = r.pilot[arm]; assert.equal(p.primary, 'incomplete_evidence'); assert.equal(p.valid_completed_trial, false); assert.notEqual(p.grade_use, 'valid'); }
    assert.equal(r.report.pilot.slots.execution_valid_pairs, 0); assert.equal(r.report.pilot.slots.assigned, 2);
  });
  test('a real host failure (sandbox infra_error) is infra_interruption with its stage', async () => {
    const r = await experiment('host', { agent: () => ({ status: 'infra_error', reason: 'docker daemon gone', diff: null, changes: [], unsupported_changes: [], sandbox: null }) });
    const p = r.pilot.A; assert.equal(p.primary, 'infra_interruption', JSON.stringify(p)); assert.equal(p.cause.kind, 'host');
  });
});
