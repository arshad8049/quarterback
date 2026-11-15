// Arm A: the trial path (lib/pilot/arm-a.js runTrial → runAgentSandboxed → pilot records) with a FAKE Claude Code
// executable stream behind the runSandboxed seam. No Docker, no model, no network; tokens are dummies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const A = require('../../lib/pilot/arm-a');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const amendBytes = fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/amendments/amendment-1.json'));
const amendment = JSON.parse(amendBytes);

function stream({ model = 'claude-opus-5-5', version = '2.1.322', apiKeySource = 'none', rate = { status: 'allowed', isUsingOverage: false }, api429 = false, noRate = false } = {}) {
  const ev = [
    { type: 'system', subtype: 'init', claude_code_version: version, model, apiKeySource, permissionMode: 'dontAsk', tools: [] },
    { type: 'assistant', message: { model, content: [{ type: 'text', text: 'done' }] } },
    ...(noRate ? [] : [{ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', overageStatus: 'disabled', ...rate } }]),
    { type: 'result', subtype: 'success', is_error: false, num_turns: 3, ...(api429 ? { api_error_status: 429 } : {}),
      usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, provider: 'firstParty' } } },
  ];
  return ev.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const PATCH = Buffer.from('diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-a\n+b\n');
function seamFor({ state = 'completed', status = 'completed', patch = PATCH, stdout = stream(), agentMs = 1234, capture = 'captured', calls }) {
  return async (opts) => {
    if (calls) calls.push(opts);
    const r = { status, diff: patch.length ? patch.toString('utf8') : null, changes: patch.length ? [{ file: 'src/x.js', status: 'M' }] : [], unsupported_changes: [],
      base_tree: 'b'.repeat(40), candidate_tree: 'c'.repeat(40), exit_code: 0, signal: null, stderr_tail: null, patch_raw: patch.length ? patch : null,
      agent_stdout: stdout, agent_stdout_dropped: 0,
      sandbox: { credential_mode: 'K', stages: { agent: { state, duration_ms: agentMs } }, capture: { verdict: { state: patch.length ? capture : 'no_change' } } } };
    return r;
  };
}
const okSignIn = async () => ({ status: 'ok' });
const base = (extra) => ({ briefing: 'Fix it.\n', repoPath: '/nonexistent', amendment, amendmentSha256: sha(amendBytes), signInAdapter: okSignIn,
  label: 'trial-live', trialId: 't1', taskId: 'qbt_2b0029100b75', graderTask: 'preact-2757', ...extra });

test('a verified attempt: one attempt, the frozen profile and 1,800 s allowance, the exact captured bytes, gradable', async () => {
  const calls = [];
  const r = await A.runTrial(base({ seam: seamFor({ calls }) }));
  assert.equal(calls.length, 1, 'exactly one attempt');
  assert.equal(r.coding_ms, 1_800_000); assert.equal(r.total_ms, 5_400_000);
  assert.ok(calls[0].agentArgs.includes('claude-opus-5-5') && calls[0].agentArgs.includes('dontAsk'));
  assert.equal(calls[0].briefing, 'Fix it.\n');
  assert.equal(r.pilot.primary, 'execution_verified');
  assert.equal(r.patch.equals(PATCH), true);
  assert.equal(r.candidate.sha256, sha(PATCH)); assert.equal(r.candidate.grader_task, 'preact-2757');
  assert.deepEqual([r.grade_now, r.stop_batch], [true, false]);
  assert.equal(r.profile.auth_route, 'subscription_token_env');
});

test('a coding timeout keeps the captured patch and stays gradable (graded under 10583), never a batch stop', async () => {
  const r = await A.runTrial(base({ seam: seamFor({ state: 'timeout', status: 'timeout', stdout: '' }) }));
  assert.equal(r.pilot.primary, 'coding_timeout');
  assert.equal(r.pilot.patch_use, 'grade_under_10583');
  assert.deepEqual([r.grade_now, r.stop_batch, r.candidate.bytes], [true, false, PATCH.length]);
});

test('a usage limit, a sign-in failure and a machine failure are recorded apart from a wrong answer, and none is graded as a valid trial', async () => {
  const lim = await A.runTrial(base({ seam: seamFor({ stdout: stream({ api429: true, rate: { status: 'rejected', isUsingOverage: false } }) }) }));
  assert.equal(lim.pilot.primary, 'usage_limit'); assert.deepEqual([lim.grade_now, lim.stop_batch], [false, true]);

  const calls = [];
  const sign = await A.runTrial(base({ seam: seamFor({ calls }), signInAdapter: async () => ({ status: 'error' }) }));
  assert.equal(calls.length, 0, 'no sandbox after a failed sign-in');
  assert.deepEqual([sign.grade_now, sign.stop_batch], [false, true]);
  assert.ok(['infra_interruption', 'auth_timeout'].includes(sign.pilot.primary), sign.pilot.primary);

  const mach = await A.runTrial(base({ seam: async () => ({ status: 'infra_error', error: 'docker daemon gone', sandbox: null }) }));
  assert.equal(mach.pilot.primary, 'infra_interruption'); assert.equal(mach.grade_now, false); assert.equal(mach.stop_batch, false);
});

test('a wrong served model, a wrong CLI version or a paid billing route is a policy/evidence failure that stops the batch', async () => {
  const wrong = await A.runTrial(base({ seam: seamFor({ stdout: stream({ model: 'claude-sonnet-5-5' }) }) }));
  assert.equal(wrong.pilot.primary, 'policy_violation'); assert.deepEqual([wrong.grade_now, wrong.stop_batch], [false, true]);
  const paid = await A.runTrial(base({ seam: seamFor({ stdout: stream({ rate: { status: 'allowed', isUsingOverage: true } }) }) }));
  assert.equal(paid.pilot.primary, 'policy_violation');
  const key = await A.runTrial(base({ seam: seamFor({ stdout: stream({ apiKeySource: 'ANTHROPIC_API_KEY' }) }) }));
  assert.equal(key.pilot.primary, 'policy_violation');
  const ver = await A.runTrial(base({ seam: seamFor({ stdout: stream({ version: '2.1.999' }) }) }));
  assert.equal(ver.pilot.primary, 'incomplete_evidence'); assert.equal(ver.grade_now, false);
  const noBilling = await A.runTrial(base({ seam: seamFor({ stdout: stream({ noRate: true }) }) }));
  assert.equal(noBilling.pilot.primary, 'incomplete_evidence', 'missing billing evidence is unknown, never free');
});

test('without the seam, the live route is refused before any sandbox unless every guard condition holds', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ARM_A_LIVE; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'dummy-not-a-token';
    const r = await A.runTrial(base({ signInAdapter: A.signInAdapter() }));
    assert.equal(r.grade_now, false); assert.equal(r.sandbox, null, 'nothing ran');
    assert.match(r.pilot.reasons.join(' '), /arm-A route|not confirmed|research driver/);
    assert.equal(r.stop_batch, true);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('experiment-run and ordinary QB runs still refuse the route: APPROVED_AUTH_ROUTES is empty and pilotSetup needs the test seam', () => {
  const P = require('../../lib/sandbox/agent-profile');
  const errs = P.checkProfile({ ...P.profileFromConfig(P.loadReviewed()), auth_route: 'subscription_token_env' }, { imagePin: require('../../lib/sandbox/agent').CLAUDE_VERSION });
  assert.match(errs.join(' '), /not approved/);
});

test('the in-job scanner: the exact secret value and secret patterns are always refused; test names only in public records', () => {
  const secret = 'dummy-oauth-value-1234567890';
  assert.deepEqual(A.scanText(`x ${secret} y`, { secret, kind: 'secret_only' }).refused, ['exact secret value']);
  assert.deepEqual(A.scanText('token sk-ant-oat01-abcdefghijk', { kind: 'secret_only' }).refused, ['secret pattern']);
  const names = ['should set progress value to 0'];
  const testPatch = '+  expect(scratch.firstChild.value).to.equal(0);\n';
  const patch = 'diff --git a/test/a.js b/test/a.js\n+it("should set progress value to 0", () => {\n+  expect(scratch.firstChild.value).to.equal(0);\n';
  const c = A.scanText(patch, { secret, names, testPatch, kind: 'secret_only' });
  assert.deepEqual(c.refused, [], 'the candidate patch may contain diff text and test names');
  assert.equal(c.hidden_overlap_lines, 1, 'hidden-answer overlap is counted for the record');
  assert.deepEqual(A.scanText(patch, { secret, names, testPatch, kind: 'public' }).refused.sort(), ['diff text', 'hidden test-patch line', 'required test name']);
});
