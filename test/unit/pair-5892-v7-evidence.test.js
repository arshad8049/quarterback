// KAN-114 10689 (freeze v7): per-attempt served-model / CLI / billing evidence for BOTH paired arms, carried from QB's
// runner through runPipeline into the durable sanitized trial record, classified on EVERY attempt, and checked again
// after a serialized write → readback. Missing or wrong evidence stops further attempts and the trial is never
// execution_verified. All streams here are SIMULATED (fake Claude stream behind the runSandboxed seam): no Docker,
// model, network or real token; none of this is a live model or billing check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const PAIR = require('../../lib/pilot/pair');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const amendBytes = fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/amendments/amendment-1.json'));
const amendment = JSON.parse(amendBytes);
const MODEL = 'claude-opus-5-5';

/** A simulated stream-json; each knob breaks exactly one piece of evidence. */
function stream({ model = MODEL, initModel = model, version = '2.1.322', apiKeySource = 'none', overage = false, rate = true, result = true, init = true } = {}) {
  return [
    ...(init ? [{ type: 'system', subtype: 'init', claude_code_version: version, model: initModel, apiKeySource, permissionMode: 'dontAsk', tools: [] }] : []),
    { type: 'assistant', message: { model, content: [{ type: 'text', text: 'done' }] } },
    ...(rate ? [{ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', overageStatus: 'disabled', status: 'allowed', isUsingOverage: overage } }] : []),
    ...(result ? [{ type: 'result', subtype: 'success', is_error: false, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, provider: 'firstParty' } } }] : []),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const patchN = (n) => `diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-a\n+b${n}\n`;
/** fake sandbox: attempt n gets streams[n-1] (or a valid stream); QB verification fails until passOn */
function fakeSandbox(calls, { streams = [], dropped = [], passOn = 99, agentMs = 300_000 } = {}) {
  return async (opts) => {
    calls.push(opts);
    const n = calls.length; const P = patchN(n);
    return { status: 'completed', diff: P, changes: [{ file: 'lib/x.js', status: 'M', additions: 1, deletions: 1, binary: false }], unsupported_changes: [],
      base_tree: 'b'.repeat(40), candidate_tree: `t${n}`, exit_code: 0, signal: null, stderr_tail: null, patch_raw: Buffer.from(P),
      agent_stdout: streams[n - 1] !== undefined ? streams[n - 1] : stream(), agent_stdout_dropped: dropped[n - 1] || 0,
      sandbox: { credential_mode: 'K', stages: { agent: { state: 'completed', duration_ms: agentMs } }, capture: { verdict: { state: 'captured' } },
        verification: { mode: 'research_mocha', status: 'ran', verdict: 'passed', reasons: [], validation: { counts: { total: 1, passed: 1, failed: 0 }, identities: [], failing: [] }, steps: [{ name: 'test', exit_code: 0 }],
          prep: { status: 'ready', tree: `t${n}` }, task_base_commit: 'b'.repeat(40), protected: [':(glob)test/**'] },
        checks: { requested: opts.checks, check_set_hash: require('../../verify/checks/registry').checkSetHash(opts.checks), state: 'completed', tree: `t${n}`,
          results_text: JSON.stringify({ format: 'qb-check-results/1', complete: true, check_set_hash: require('../../verify/checks/registry').checkSetHash(opts.checks),
            results: opts.checks.map((c) => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter, status: n >= passOn ? 'pass' : 'fail', detail: n >= passOn ? 'ok' : 'scenario failed' })) }) } } };
  };
}
const { approve } = require('../../intent/contract-state');
const { validateResearchChecks } = require('../../lib/research/reviewed-checks');
const SRC = "module.exports = async ({ require, assert }) => { assert.ok(require('./lib/x.js')); };";
const AC = [{ id: 'AC-1', criterion: 'x works', met: null, kind: 'behavioral', requirement_ids: ['R-1'] }];
const CHECKS = validateResearchChecks([{ id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', params: { source: SRC } }], AC,
  { reviewed: [{ check_id: 'SC-1', source_sha256: sha(SRC), reviewed_by: 'fixture', ref: 'fixture' }] }).accepted;
const contract = approve({ id: 'c', goal: 'make x work', raw_request: 'make x work', requirements: [{ id: 'R-1', quote: 'make x work' }], acceptance_criteria: AC, clarifying_question: null, checks: CHECKS, checks_registry: 'qb-checks/3',
  scope: { allowed_changes: ['lib/**'] }, test_policy: { preexisting_failures: 'waive' } }, { via: 'test' });
const research = { env: { task_id: 'qbt_x', key: 'axios-x' }, rootScripts: [{ key: 'axios-x' }], checkRunner: { path: '/opt/qb-research/qb-check-runner.mjs', sha256: 'e'.repeat(64) } };
function repo() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pairv7-')); fs.writeFileSync(path.join(d, 'README.md'), 'x\n'); return d; }
const baseB = (extra) => ({ contract, repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }), approvedAuthRoutes: ['subscription_token_env'],
  research, preservationMaps: [], trialId: 't1', taskId: 'qbt_x', graderTask: 'axios-x', runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pairv7-runs-')), ...extra });
const CTX = { arm: 'B', mode: 'task', live: false, simulated: true, freeze: 'pair-5892-freeze-v7', task: 'axios-x', taskId: 'qbt_x' };

/** the production record assembly + the serialized artifact readback (what the upload carries) */
function writeAndReadBack(res, ctx = CTX) {
  const summary = PAIR.pairSummary(res, ctx);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pairv7-pub-')), `pair-${ctx.arm}.json`);
  fs.writeFileSync(f, `${JSON.stringify(summary, null, 2)}\n`);
  const back = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { summary, back, problems: PAIR.recordProblems(back) };
}

test('v7 complete valid sequence: every QB attempt carries its own served model, CLI, billing and patch link; the readback verifies', async () => {
  const calls = [];
  const res = await PAIR.runArmB(baseB({ seam: fakeSandbox(calls, { passOn: 3 }) }));
  assert.equal(calls.length, 3);
  assert.equal(res.pilot.primary, 'execution_verified');
  const { back, problems } = writeAndReadBack(res);
  assert.deepEqual(problems, []);
  assert.equal(back.evidence.verified, true);
  assert.equal(back.attempt_evidence.length, 3);
  back.attempt_evidence.forEach((e, i) => {
    assert.equal(e.attempt, i + 1);
    assert.equal(e.outcome, 'verified');
    assert.equal(e.requested_model, MODEL); assert.equal(e.served_model, MODEL); assert.equal(e.cli, '2.1.322');
    assert.equal(e.provider, 'firstParty'); assert.equal(e.api_key_source, 'none'); assert.equal(e.is_using_overage, false);
    assert.equal(e.evidence_complete, true);
    assert.equal(e.patch_sha256, sha(patchN(i + 1)), 'each attempt is linked to its own captured bytes');
    assert.equal(e.agent_stage_ms, 300_000);
  });
  assert.equal(back.model.served, MODEL, 'the top-level model comes from the attempts, all of which agree');
  assert.equal(back.evidence_label, 'SIMULATED: fake stream behind the test seam; not a live model or billing check');
  assert.equal(back.candidate.sha256, sha(patchN(3)));
  assert.equal(back.attempt_evidence[2].patch_sha256, back.candidate.sha256, 'the graded candidate is the last attempt');
});

const stops = [
  ['missing evidence (empty stream)', { streams: [''] }, 1, 'incomplete_evidence'],
  ['mixed model across retries', { streams: [stream(), stream({ model: 'claude-sonnet-5-5', initModel: 'claude-sonnet-5-5' })] }, 2, 'policy_violation'],
  ['missing billing telemetry', { streams: [stream({ rate: false })] }, 1, 'incomplete_evidence'],
  ['overage on an earlier attempt', { streams: [stream({ overage: true }), stream()] }, 1, 'policy_violation'],
  ['interrupted / truncated stream (bytes dropped)', { dropped: [4096] }, 1, 'incomplete_evidence'],
  ['interrupted stream (no result event)', { streams: [stream({ result: false })] }, 1, 'incomplete_evidence'],
  ['API key billing route', { streams: [stream({ apiKeySource: 'ANTHROPIC_API_KEY' })] }, 1, 'policy_violation'],
];
for (const [name, knobs, attemptsRun, primary] of stops) {
  test(`v7 stop: ${name} ends the trial at that attempt; never execution_verified; the readback refuses it`, async () => {
    const calls = [];
    const res = await PAIR.runArmB(baseB({ seam: fakeSandbox(calls, knobs) }));
    assert.equal(calls.length, attemptsRun, 'no further QB attempt after missing or wrong evidence');
    assert.equal(res.pilot.primary, primary);
    assert.notEqual(res.pilot.primary, 'execution_verified');
    assert.equal(res.pilot.valid_completed_trial, false);
    assert.equal(res.grade_now, false, 'not graded as a valid trial');
    assert.equal(res.evidence_stopped && res.evidence_stopped.attempt, attemptsRun);
    const { back, problems } = writeAndReadBack(res);
    assert.ok(problems.length > 0);
    assert.equal(back.evidence.verified, false);
    assert.equal(back.attempt_evidence.length, attemptsRun, 'the failing attempt is kept in the record');
    if (primary === 'policy_violation' || name.includes('billing') || name.includes('truncated')) assert.equal(back.model, null);
  });
}

test('v7: earlier overage followed by a clean final attempt still fails the trial (every attempt is classified, not only the last)', () => {
  const entries = [
    { attempt: 1, outcome: 'policy_violation', flags: ['policy_violation'], requested_model: MODEL, served_model: MODEL, cli: '2.1.322', provider: 'firstParty', api_key_source: 'none', is_using_overage: true, evidence_complete: true },
    { attempt: 2, outcome: 'verified', flags: ['verified'], requested_model: MODEL, served_model: MODEL, cli: '2.1.322', provider: 'firstParty', api_key_source: 'none', is_using_overage: false, evidence_complete: true },
  ];
  const p = PAIR.evidenceProblems(entries, { model: MODEL, claude_code_version: '2.1.322' }, 2);
  assert.ok(p.some((x) => /attempt 1/.test(x) && /overage/.test(x)), p.join('; '));
  const rec = { primary: 'execution_verified', attempts: 2, profile: { model: MODEL, claude_code_version: '2.1.322' }, attempt_evidence: entries, evidence: { verified: true } };
  assert.ok(PAIR.recordProblems(rec).length > 0, 'a record that claims verified with an overage attempt is refused on readback');
});

test('v7: the configured profile alone can NOT satisfy verification (the v6 gap: model/billing null, profile.model set)', () => {
  const v6Like = { primary: 'execution_verified', attempts: 1, model: null, billing_route: null, profile: { model: MODEL, claude_code_version: '2.1.322' } };
  const p = PAIR.recordProblems(v6Like);
  assert.ok(p.some((x) => /no per-attempt evidence/.test(x)), p.join('; '));
  assert.ok(p.some((x) => /execution_verified/.test(x)), p.join('; '));
  // fewer evidence entries than attempts run
  const one = { attempt: 1, outcome: 'verified', flags: ['verified'], requested_model: MODEL, served_model: MODEL, cli: '2.1.322', provider: 'firstParty', api_key_source: 'none', is_using_overage: false, evidence_complete: true };
  assert.ok(PAIR.recordProblems({ ...v6Like, attempts: 2, attempt_evidence: [one], evidence: { verified: true } }).some((x) => /2 attempt/.test(x)));
  assert.deepEqual(PAIR.evidenceProblems([one], { model: MODEL, claude_code_version: '2.1.322' }, 1), []);
  // a served-model field copied from the profile but with no classified outcome is not evidence
  assert.ok(PAIR.evidenceProblems([{ attempt: 1, served_model: MODEL }], { model: MODEL, claude_code_version: '2.1.322' }, 1).length > 0);
});

test('v7 arm A: the same per-attempt evidence record (one attempt) and the same readback gate', async () => {
  const seam = async () => ({ status: 'completed', diff: patchN(1), changes: [{ file: 'lib/x.js', status: 'M', additions: 1, deletions: 1, binary: false }], unsupported_changes: [], base_tree: 'b'.repeat(40), candidate_tree: 't1',
    exit_code: 0, signal: null, stderr_tail: null, patch_raw: Buffer.from(patchN(1)), agent_stdout: stream(), agent_stdout_dropped: 0,
    sandbox: { credential_mode: 'K', stages: { agent: { state: 'completed', duration_ms: 1000 } }, capture: { verdict: { state: 'captured' } } } });
  const res = await PAIR.runArmA({ briefing: 'Fix it.\n', repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }),
    seam, research: { rootScripts: research.rootScripts }, label: 'pair-a-dry', trialId: 't', taskId: 'qbt_x', graderTask: 'axios-x' });
  const { back, problems } = writeAndReadBack(res, { ...CTX, arm: 'A' });
  assert.deepEqual(problems, []);
  assert.equal(back.attempt_evidence.length, 1);
  assert.equal(back.attempt_evidence[0].patch_sha256, sha(patchN(1)));
  const bad = await PAIR.runArmA({ briefing: 'Fix it.\n', repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }),
    seam: async (o) => ({ ...(await seam(o)), agent_stdout: stream({ rate: false }) }), research: { rootScripts: research.rootScripts }, label: 'pair-a-dry', trialId: 't', taskId: 'qbt_x', graderTask: 'axios-x' });
  assert.notEqual(bad.pilot.primary, 'execution_verified');
  assert.ok(writeAndReadBack(bad, { ...CTX, arm: 'A' }).problems.length > 0);
});

test('v7 record: raw research-channel verdict and the policy-adjusted test outcome are separately named', async () => {
  const res = await PAIR.runArmB(baseB({ seam: fakeSandbox([], { passOn: 1 }) }));
  const { back } = writeAndReadBack(res);
  const lr = back.diagnostics.last_report;
  assert.ok(!('verification' in lr), 'the ambiguous v6 field name is gone');
  assert.deepEqual(Object.keys(lr.raw_channel_verification).sort(), ['counts', 'reason', 'reasons', 'status', 'verdict']);
  assert.equal(lr.raw_channel_verification.verdict, 'passed');
  assert.equal(lr.policy_adjusted_test_outcome.outcome, 'passed');
  assert.ok(['regressions', 'frozen_exceptions', 'isolation_qualified'].every((k) => Number.isInteger(lr.policy_adjusted_test_outcome[k])));
});
