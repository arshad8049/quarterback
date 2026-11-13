/**
 * KAN-112 review 10599: amendment 1 to the frozen pilot config (10583/10586). Boundary tests: shared coding
 * budget, the total deadline during each stage and during sign-in, empty/missing billing events, simultaneous
 * outcomes (all flags kept), cleanup after the deadline, accounting that never drops slots, and tampering.
 * Pure functions only: no Docker, no model, no credentials.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const AMD = path.join(ROOT, 'bench', 'opus-pilot', 'amendments', 'amendment-1.json');
const BASE = path.join(ROOT, 'bench', 'opus-pilot', 'pilot-config.json');
const M = () => import(path.join(ROOT, 'bench', 'opus-pilot', 'trial-policy.mjs'));
const P = require('../../lib/sandbox/agent-profile');
const amd = () => JSON.parse(fs.readFileSync(AMD, 'utf8'));
const profile = () => ({ ...P.profileFromConfig(P.loadReviewed()), auth_route: 'test-only-route' });
const MIN = 60_000;

// A stream-json transcript (observed field names, synthetic values)
const line = (o) => JSON.stringify(o);
const stream = ({ rates = [{ status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false }], model = 'claude-opus-5-5', keySource = 'none' } = {}) => [
  line({ type: 'system', subtype: 'init', claude_code_version: '2.1.322', model, apiKeySource: keySource }),
  line({ type: 'assistant', message: { model } }),
  ...rates.map((r) => line({ type: 'rate_limit_event', rate_limit_info: r })),
  line({ type: 'result', subtype: 'success', modelUsage: { [model]: { inputTokens: 1, outputTokens: 1, provider: 'firstParty' } } }),
].join('\n') + '\n';

describe('KAN-112 10599: the amendment is versioned and never rewrites the frozen config', () => {
  test('it references 10599, 10583 and 10586 and pins the base config by hash', async () => {
    const a = amd(); const { checkAmendment } = await M();
    assert.equal(a.amends, 'bench/opus-pilot/pilot-config.json'); assert.equal(a.approved_by, 10599);
    assert.deepEqual(a.references, [10583, 10586]);
    assert.equal(a.base_sha256, crypto.createHash('sha256').update(fs.readFileSync(BASE)).digest('hex'));
    assert.deepEqual(checkAmendment(a, fs.readFileSync(BASE)), []);
  });
  test('the frozen base still says frozen_by 10583 and has no amendment fields mixed in', () => {
    const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    assert.equal(b.frozen_by, 10583); assert.equal(b.budgets.coding_wall_clock_s, 1800);
    assert.equal(b.budgets.trial_total_s, undefined); assert.equal(b.budgets.sign_in_max_s, undefined);
  });
  test('the accepted caps: 1,800 s shared coding, A=1 / E<=3, 10 min sign-in, 90 min per arm-trial', () => {
    const t = amd().time;
    assert.equal(t.coding_s, 1800); assert.equal(t.sign_in_max_s, 600); assert.equal(t.trial_total_s, 5400);
    assert.equal(t.total_starts_at, 'arm_trial_start_before_first_setup_or_sign_in');
    assert.deepEqual(amd().attempts, { A: 1, E: 3 });
  });
  for (const [why, mutate, re] of [
    ['a tampered base config', null, /base config hash/],
    ['a changed total cap', (a) => { a.time.trial_total_s = 7200; }, /trial_total_s/],
    ['a changed sign-in cap', (a) => { a.time.sign_in_max_s = 1200; }, /sign_in_max_s/],
    ['a changed coding budget', (a) => { a.time.coding_s = 3600; }, /coding_s/],
    ['a dropped reference', (a) => { a.references = [10583]; }, /references/],
    ['an extra arm attempt', (a) => { a.attempts.A = 2; }, /attempts/],
    ['a credential-like key', (a) => { a.time.api_token = 'x'; }, /credential-like/],
  ]) {
    test(`checkAmendment refuses ${why}`, async () => {
      const { checkAmendment } = await M(); const a = amd(); let base = fs.readFileSync(BASE);
      if (mutate) mutate(a); else base = Buffer.concat([base, Buffer.from(' ')]);
      assert.ok(checkAmendment(a, base).some((e) => re.test(e)), JSON.stringify(checkAmendment(a, base)));
    });
  }
});

describe('KAN-112 10599: one clock per arm-trial; every stage, sign-in and coding respect what remains', () => {
  test('the clock starts at arm-trial start and caps each stage at the remaining total', async () => {
    const { TrialClock } = await M(); const c = new TrialClock(amd(), { startMs: 0 });
    assert.equal(c.stageBudgetMs('deps', 20 * MIN, 0), 20 * MIN);
    assert.equal(c.stageBudgetMs('verify', 20 * MIN, 80 * MIN), 10 * MIN);
    assert.equal(c.stageBudgetMs('verify', 20 * MIN, 90 * MIN), 0);
  });
  test('sign-in gets min(10 min, remaining total) and none once the coding budget is spent', async () => {
    const { TrialClock } = await M(); const c = new TrialClock(amd(), { startMs: 0 });
    assert.equal(c.signInBudgetMs(0), 10 * MIN);
    assert.equal(c.signInBudgetMs(85 * MIN), 5 * MIN);
    c.debitCoding(1800_000); assert.equal(c.signInBudgetMs(1 * MIN), 0);
  });
  test('coding is shared across attempts and also capped by the remaining total', async () => {
    const { TrialClock } = await M(); const c = new TrialClock(amd(), { startMs: 0 });
    c.debitCoding(20 * MIN); assert.equal(c.codingBudgetMs(25 * MIN), 10 * MIN);
    c.debitCoding(9 * MIN); assert.equal(c.codingBudgetMs(40 * MIN), 1 * MIN);
    const late = new TrialClock(amd(), { startMs: 0 }); assert.equal(late.codingBudgetMs(85 * MIN), 5 * MIN);
  });
  test('cleanup is always scheduled, even after the total deadline (it is not budgeted against the trial)', async () => {
    const { TrialClock } = await M(); const c = new TrialClock(amd(), { startMs: 0 });
    assert.equal(c.mustRunCleanup(95 * MIN), true); assert.equal(c.stageBudgetMs('cleanup', 5 * MIN, 95 * MIN), 5 * MIN);
  });
  test('preparation outside the trial is recorded separately and does not consume the trial clock', async () => {
    const { TrialClock } = await M(); const c = new TrialClock(amd(), { startMs: 10 * MIN, preparationMs: 30 * MIN });
    assert.equal(c.report(20 * MIN).preparation_ms, 30 * MIN); assert.equal(c.report(20 * MIN).total_elapsed_ms, 10 * MIN);
  });
});

describe('KAN-112 10599: trial outcomes keep the cause; total expiry is not automatically infrastructure', () => {
  const ev = (extra = {}) => ({ attempts: [{ stream: stream(), dropped: 0, sandboxState: 'completed' }], ...extra });
  test('the total deadline during ordinary QB stages is pipeline_total_timeout with its stage, not INFRA', async () => {
    const { classifyTrial } = await M();
    for (const stage of ['setup', 'deps', 'agent', 'capture', 'verify']) {
      const r = classifyTrial(ev({ totalDeadline: { hit: true, stage } }), profile());
      assert.equal(r.primary, 'pipeline_total_timeout'); assert.equal(r.cause.stage, stage); assert.ok(!r.flags.includes('infra_interruption'));
    }
  });
  test('sign-in expiry is auth_timeout; a real host/network failure is infra_interruption', async () => {
    const { classifyTrial } = await M();
    assert.equal(classifyTrial(ev({ signIn: { timedOut: true } }), profile()).primary, 'auth_timeout');
    const h = classifyTrial(ev({ hostFailure: { kind: 'network', stage: 'agent' } }), profile());
    assert.equal(h.primary, 'infra_interruption'); assert.equal(h.cause.kind, 'network');
  });
  test('coding_timeout stays separate and its captured patch is gradable under 10583', async () => {
    const { classifyTrial } = await M();
    const r = classifyTrial({ attempts: [{ stream: stream(), sandboxState: 'timeout' }], patchCaptured: true }, profile());
    assert.equal(r.primary, 'coding_timeout'); assert.equal(r.patch_use, 'grade_under_10583');
  });
  test('a patch from any other interruption is diagnostic only and never a valid completed trial', async () => {
    const { classifyTrial } = await M();
    for (const x of [{ signIn: { timedOut: true } }, { hostFailure: { kind: 'host' } }, { totalDeadline: { hit: true, stage: 'verify' } }]) {
      const r = classifyTrial(ev({ ...x, patchCaptured: true }), profile());
      assert.equal(r.patch_use, 'diagnostic_only'); assert.equal(r.valid_completed_trial, false);
    }
  });
  test('"execution_verified" is about evidence only: the grader outcome is a separate field, never inferred', async () => {
    const { classifyTrial } = await M(); const r = classifyTrial(ev(), profile());
    assert.equal(r.primary, 'execution_verified'); assert.equal(r.execution_evidence, 'verified'); assert.equal(r.grader_outcome, null);
    assert.equal(classifyTrial(ev({ graderOutcome: 'FAIL' }), profile()).grader_outcome, 'FAIL');
  });
  test('simultaneous outcomes: one primary label, every flag preserved (timeout + missing evidence)', async () => {
    const { classifyTrial } = await M();
    const r = classifyTrial({ attempts: [{ stream: stream({ rates: [] }), sandboxState: 'timeout' }] }, profile());
    assert.equal(r.primary, 'coding_timeout'); assert.ok(r.flags.includes('incomplete_evidence')); assert.ok(r.flags.includes('coding_timeout'));
    const v = classifyTrial({ attempts: [{ stream: stream({ rates: [{ status: 'rejected', isUsingOverage: true }] }), sandboxState: 'timeout' }] }, profile());
    assert.equal(v.primary, 'policy_violation'); for (const f of ['policy_violation', 'usage_limit', 'coding_timeout']) assert.ok(v.flags.includes(f), f);
  });
});

describe('KAN-112 10599: billing evidence must be explicit; missing is unknown', () => {
  test('no rate-limit event at all is NOT verified (an empty array must not pass an every() check)', () => {
    const c = P.classifyAttempt({ stdout: stream({ rates: [] }) }, profile());
    assert.equal(c.outcome, 'incomplete_evidence'); assert.match(c.reasons.join(' '), /billing telemetry missing/);
  });
  test('a rate-limit event without a boolean overage flag is unknown', () => {
    const c = P.classifyAttempt({ stdout: stream({ rates: [{ status: 'allowed' }] }) }, profile());
    assert.equal(c.outcome, 'incomplete_evidence');
  });
  test('one overage event among many allowed ones is a violation', () => {
    const c = P.classifyAttempt({ stdout: stream({ rates: [{ status: 'allowed', isUsingOverage: false }, { status: 'allowed', isUsingOverage: true }] }) }, profile());
    assert.equal(c.outcome, 'policy_violation');
  });
  test('classifyAttempt reports every category that applied, not just the winning one', () => {
    const c = P.classifyAttempt({ stdout: stream({ rates: [] }), sandboxState: 'timeout' }, profile());
    assert.deepEqual(c.flags.sort(), ['coding_timeout', 'incomplete_evidence']);
  });
  test('the amendment names what counts as sufficient billing evidence', () => {
    const b = amd().billing_evidence_sufficient;
    for (const k of ['api_key_source_none', 'at_least_one_rate_limit_event', 'every_event_overage_false_boolean', 'provider_first_party_every_model']) assert.ok(b.includes(k), k);
  });
});

describe('KAN-112 10599: accounting keeps every assigned slot', () => {
  test('refused, interrupted and verified slots all stay visible; valid pairs are counted separately', async () => {
    const { accountSlots } = await M();
    const slots = [
      { task: 't1', arm: 'A', primary: 'execution_verified' }, { task: 't1', arm: 'B', primary: 'execution_verified' },
      { task: 't2', arm: 'A', primary: 'preflight_refused' }, { task: 't2', arm: 'B', primary: 'execution_verified' },
      { task: 't3', arm: 'A', primary: 'auth_timeout' }, { task: 't3', arm: 'B', primary: 'coding_timeout' },
    ];
    const r = accountSlots(slots);
    assert.equal(r.assigned, 6); assert.equal(r.refused, 1); assert.equal(r.executed, 5); assert.equal(r.interrupted, 1);
    assert.equal(r.execution_valid_pairs, 1); assert.equal(r.slots.length, 6);
    assert.deepEqual(r.by_outcome, { execution_verified: 3, preflight_refused: 1, auth_timeout: 1, coding_timeout: 1 });
  });
  test('a rerun keeps the original and needs an approval id', async () => {
    const { accountSlots } = await M();
    assert.throws(() => accountSlots([{ task: 't1', arm: 'A', primary: 'auth_timeout' }, { task: 't1', arm: 'A', primary: 'execution_verified', rerun_of: 0 }]), /approval/);
    const r = accountSlots([{ task: 't1', arm: 'A', primary: 'auth_timeout' }, { task: 't1', arm: 'A', primary: 'execution_verified', rerun_of: 0, rerun_approved_by: 12345 }]);
    assert.equal(r.slots.length, 2); assert.equal(r.reruns, 1); assert.equal(r.assigned, 1);
  });
  test('time and effort are reported separately for each arm', async () => {
    const { TrialClock } = await M(); const c = new TrialClock(amd(), { startMs: 0 });
    c.debitCoding(5 * MIN); c.recordHuman('sign_in', 2 * MIN); c.recordHuman('contract_authoring', 15 * MIN);
    const r = c.report(40 * MIN);
    assert.deepEqual(Object.keys(r).sort(), ['coding_ms', 'human_ms', 'preparation_ms', 'total_elapsed_ms']);
    assert.deepEqual(r.human_ms, { sign_in: 2 * MIN, contract_authoring: 15 * MIN });
  });
});
