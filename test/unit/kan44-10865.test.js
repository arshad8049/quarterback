/**
 * KAN-44 senior ruling 10865: a security-held benchmark trial.
 *   - it never reaches the grader and never gets an ordinary coding-quality score;
 *   - its patch stays out of the experiment directory (only the permitted metadata is there), and the exact original
 *     stays in the local run record, for every arm;
 *   - it stays in the planned denominator as a non-success (attrition), with hold counts by arm and the number of
 *     planned pairs that lack a usable pair;
 *   - any completed-pairs-only analysis is labelled secondary and selection-limited;
 *   - no replacement trial is run for it.
 * These run the real producer (runExperiment → runArm → grader → recordTrial → reportData) with a stand-in agent
 * whose patch carries a DUMMY credential and a credential scan that reports a finding. No model, no Docker.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runExperiment, taskEntries, armDefinitions } = require('../../bench/experiment-run');
const { createExperiment, loadExperiment } = require('../../bench/experiment');
const { reportData, buildReport } = require('../../bench/report');
const { GRADER_FILES } = require('../../bench/grader');
const { qualify } = require('../../bench/qualify');
const budget = require('../../lib/budget');
const S = require('../../bench/schemas');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture, IMPL } = require('../helpers/grading-fixture');

const DUMMY = 'sk-ant-DUMMYDUMMYDUMMY0000kan44test';   // not a real credential
const HELD_PATCH = `diff --git a/src/duration.js b/src/duration.js\n--- a/src/duration.js\n+++ b/src/duration.js\n@@ -1 +1,2 @@\n module.exports.formatDuration = (ms) => \`\${ms}ms\`;\n+// ${DUMMY}\n`;
const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s',
  required_behavior: ['formatDuration(30000) returns "30s"'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };
const PROBES = { git: (args) => Buffer.from(args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''), claudeVersion: () => 'unknown',
  agentVersion: () => 't', agentConfig: () => ({}), images: () => ({}), models: () => [], ensureImages: async () => {} };

const report = (pass) => [
  { type: 'qb:start', format: 'qb-node-test-events/1' },
  { type: pass ? 'test:pass' : 'test:fail', name: 'hidden', nesting: 0, path: [], file: '/verify/test/a.test.js', kind: 'test', skip: false, todo: false,
    ...(pass ? {} : { failureType: 'testCodeFailure', error: 'expected 30s' }) },
  { type: 'test:summary', file: null, counts: { tests: 1, passed: pass ? 1 : 0, failed: pass ? 0 : 1, cancelled: 0, skipped: 0, todo: 0 }, success: pass },
  { type: 'qb:end' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';
/** The grading stand-in (as in qb30-agent-failure): records every call; passes exactly when the patch installs the correct implementation. */
const graderRunner = (calls = []) => async (o) => {
  calls.push(o);
  const added = String(o.applyPatch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n') + '\n';
  const pass = added === IMPL.correct;
  return { status: 'completed', changes: [{ file: 'src/duration.js' }], sandbox: { stages: { agent: { exit_code: 0 } },
    verification: { status: 'ran', state: pass ? 'completed' : 'execution_error', exit_code: pass ? 0 : 1, report: report(pass), report_error: null, output: '' } } };
};

const held = () => ({ status: 'completed', diff: HELD_PATCH, patch_raw: Buffer.from(HELD_PATCH), changes: [{ file: 'src/duration.js', additions: 1, deletions: 0 }],
  unsupported_changes: [], exit_code: 0,
  sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'completed', exit_code: 0, duration_ms: 1000 } },
    credential_scan: { schema: 'qb-credential-scan/2', status: 'finding', findings: [{ kind: 'anthropic_key', count: 1, file_index: 1, where: 'content' }], unscanned: { binary_files: 0 }, limits: [] } } });
const quiet = () => ({ status: 'no_change', diff: null, changes: [], unsupported_changes: [], exit_code: 0,
  sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'completed', exit_code: 0, duration_ms: 1000 } } } });

let tmp; const fixtures = [];
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan44-10865-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });

/** Every file under dir, recursively. */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/**
 * One experiment (A and E) run through the real producer. `agentFor(call)` picks the stand-in agent's reply per call.
 * Returns the experiment dir, the runs dir, the agent and grader call counts, and a `rerun()` that resumes it.
 */
async function experiment(label, { repetitions, agentFor }) {
  const f = gradingFixture(); fixtures.push(f);
  const q = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: graderRunner(), reference: f.patch('correct'),
    incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
  const spec = { ...f.spec, oracle: ORACLE, qualification: q };
  const pins = { qb: { commit: 'a'.repeat(40), dirty: false, dirty_patch_sha256: null }, agent: { name: 'claude-code', adapter_version: 't', cli_version: 'unknown' },
    images: {}, node: process.version, grader: { files: Object.fromEntries(GRADER_FILES.map((g) => [g, S.sha256File(path.join(__dirname, '../..', g))])) }, models: [] };
  const { dir } = createExperiment({ dir: path.join(tmp, label), kind: 'exploratory', tasks: taskEntries([spec]), arms: armDefinitions(['A', 'E']),
    primary_comparison: ['A', 'E'], budget: { agent_time_ms: 60_000, trial_deadline_ms: 120_000, model_call_deadline_ms: 30_000, total_compute_controlled: false },
    repetitions, pins, memory: { starting_store_sha256: null } });
  const runsDir = path.join(tmp, `${label}-runs`);
  const state = { agentCalls: 0, graderCalls: [] };
  const agent = async () => agentFor(state.agentCalls++);
  const go = async () => {
    const m = mockFetch(ollamaReply({ met: false, evidence: 'no change', repair: 'Render whole seconds' }));
    try {
      await runExperiment(dir, { specs: { [spec.id]: spec }, runSandboxed: agent, runsDir, preflight: { probes: PROBES },
        grader: { suitesRoot: f.suitesRoot, runSandboxed: graderRunner(state.graderCalls) } });
    } finally { m.restore(); budget.endRun(); }
  };
  await go();
  return { dir, runsDir, state, rerun: go };
}

describe('KAN-44 10865: a security-held trial in the benchmark', () => {
  let all;   // every call held: both arms of the one planned repetition
  let mixed; // only the first agent call held: one arm of repetition 1 (seeded order), everything else clean
  before(async () => {
    all = await experiment('all-held', { repetitions: 1, agentFor: () => held() });
    mixed = await experiment('one-held', { repetitions: 2, agentFor: (n) => (n === 0 ? held() : quiet()) });
  });

  test('(a) a held trial never reaches the grader and gets no ordinary score', () => {
    assert.equal(all.state.graderCalls.length, 0, 'the grader is never called for a held patch');
    const trials = loadExperiment(all.dir).trials;
    assert.deepEqual(trials.map((t) => [t.arm, t.status, t.grade_outcome, Boolean(t.artifacts['grade.json'])]).sort(),
      [['A', 'security_hold', null, false], ['E', 'security_hold', null, false]]);
    for (const r of reportData(all.dir).rows) { assert.equal(r.category, 'security_hold'); assert.equal(r.score, null); }
  });

  test('(b) the experiment directory has no patch bytes, only the permitted metadata; the exact original stays in the local run record (every arm)', () => {
    for (const file of walk(all.dir)) assert.ok(!fs.readFileSync(file).includes(DUMMY), `${path.relative(all.dir, file)} holds the held patch`);
    for (const t of loadExperiment(all.dir).trials) {
      assert.equal(t.artifacts['patch.diff'], undefined, `${t.arm}: no patch.diff`);
      const w = JSON.parse(fs.readFileSync(path.join(all.dir, t.artifacts['patch.withheld.json'].path), 'utf8'));
      assert.deepEqual(Object.keys(w).sort(), ['bytes', 'patch_sha256', 'reason']);
      assert.equal(w.patch_sha256, S.sha256(Buffer.from(HELD_PATCH)));
      // the run record of THIS trial (run.json in the experiment names it) keeps the exact bytes, locally
      const runId = JSON.parse(fs.readFileSync(path.join(all.dir, t.artifacts['run.json'].path), 'utf8')).run_id;
      const local = walk(path.join(all.runsDir, runId)).filter((p) => fs.readFileSync(p).equals(Buffer.from(HELD_PATCH)));
      assert.ok(local.length >= 1, `${t.arm}: the exact original patch is kept in the local run record ${runId}`);
    }
  });

  test('(c) a held trial stays in the planned denominator as a non-success', () => {
    const d = reportData(all.dir);
    for (const a of ['A', 'E']) {
      assert.equal(d.arms[a].planned, 1); assert.equal(d.arms[a].scored, 0); assert.equal(d.arms[a].attrition.security_hold, 1);
      assert.equal(d.analysis.completion[a].completion_rate, 0, `${a}: completion is scored / planned, the hold counts in planned`);
    }
    const op = d.analysis.operational.tasks.find((t) => t.task_id === 'T-30S');
    assert.deepEqual([op.assigned, op.success_x, op.success_y], [1, 0, 0], 'operational: the held repetition is assigned and is no success');
  });

  test('(d) hold counts by arm are shown', () => {
    const d = reportData(mixed.dir);
    const heldArm = loadExperiment(mixed.dir).trials.find((t) => t.status === 'security_hold').arm;
    const other = heldArm === 'A' ? 'E' : 'A';
    assert.deepEqual(d.security_holds_by_arm, { [heldArm]: 1, [other]: 0 });
    const text = buildReport(mixed.dir);
    assert.match(text, new RegExp(`Security holds by arm[^\\n]*${heldArm} 1[^\\n]*`));
    assert.match(text, /Security holds by arm[^\n]*not graded[^\n]*no success/i);
  });

  test('(e) the report counts the planned pairs that lack a usable pair', () => {
    const d = reportData(mixed.dir);
    assert.equal(d.matched_pairs.planned_pairs, 2);
    assert.equal(d.matched_pairs.planned_pairs_without_usable_pair, 1);
    assert.equal(d.matched_pairs.planned_pairs_without_usable_pair_security_hold, 1);
    assert.equal(d.matched_pairs.count, 1);
    assert.match(buildReport(mixed.dir), /Planned pairs: 2; without a usable pair: 1 \(1 with a security hold\)/);
  });

  test('(f) every completed-pairs-only analysis is labelled secondary and selection-limited', () => {
    const d = reportData(mixed.dir);
    assert.match(d.analysis.primary.role, /secondary/i);
    assert.match(d.analysis.primary.role, /selection-limited/i);
    assert.equal(d.analysis.primary.selection_limited, true);
    for (const s of d.analysis.secondary) { assert.match(s.role, /selection-limited/i); assert.equal(s.selection_limited, true); }
    assert.equal(d.analysis.operational.selection_limited, false, 'the planned-denominator endpoint is not selection-limited');
    const text = buildReport(mixed.dir);
    for (const line of text.split('\n').filter((l) => /matched pairs only|completed pairs only|complete-case/i.test(l))) {
      assert.match(line, /secondary/i, line); assert.match(line, /selection-limited/i, line);
    }
    assert.doesNotMatch(text, /^Primary /m, 'no completed-pairs-only line is called primary');
  });

  test('(g) no replacement trial: resuming the experiment runs nothing new for a held trial', async () => {
    const before1 = loadExperiment(all.dir).trials.map((t) => `${t.trial_id}/${t.arm}/${t.status}`).sort();
    const calls = all.state.agentCalls;
    await all.rerun();
    assert.equal(all.state.agentCalls, calls, 'no agent call on resume');
    assert.equal(all.state.graderCalls.length, 0);
    assert.deepEqual(loadExperiment(all.dir).trials.map((t) => `${t.trial_id}/${t.arm}/${t.status}`).sort(), before1);
  });
});
