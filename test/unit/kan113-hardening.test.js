/**
 * KAN-113 review 10589 (fixture-only): evidence hardening, distinct outcomes, budget binding to the reviewed config,
 * tampered/malformed profiles, timeout behaviour, and the exact prompt bytes through a fake CLI.
 * No Docker, no model, no credentials.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const P = require('../../lib/sandbox/agent-profile');
const { runAgentSandboxed } = require('../../agent/runner');
const { runArm } = require('../../bench/arms');
const runStore = require('../../run/store');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture } = require('../helpers/grading-fixture');

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'opus-pilot', 'pilot-config.json'), 'utf8'));
const PIN = (fs.readFileSync(path.join(ROOT, 'sandbox', 'agent', 'Dockerfile'), 'utf8').match(/^ARG CLAUDE_VERSION=(\S+)$/m) || [])[1];
const TEST_ROUTE = 'test-only-route';
const profile = (over = {}) => ({ ...P.profileFromConfig(CFG), auth_route: TEST_ROUTE, ...over });
const M = 'claude-opus-5-5';

// A Claude Code 2.1.322 stream-json transcript built from parts (observed field names; synthetic values)
function ev(parts = {}) {
  const o = { init: true, version: '2.1.322', model: M, assistants: [M], rate: [{ status: 'allowed', isUsingOverage: false, overageStatus: 'rejected' }],
    result: { subtype: 'success', is_error: false }, usage: { [M]: { provider: 'firstParty' } }, apiKeySource: 'none', ...parts };
  const lines = [];
  if (o.init) lines.push({ type: 'system', subtype: 'init', model: o.model, apiKeySource: o.apiKeySource, claude_code_version: o.version });
  for (const m of o.assistants) lines.push({ type: 'assistant', message: { model: m, usage: { input_tokens: 1, output_tokens: 1 } } });
  for (const r of o.rate) lines.push({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', ...r } });
  if (o.result) lines.push({ type: 'result', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: Object.fromEntries(Object.entries(o.usage).map(([k, v]) => [k, { canonicalModel: k, thinkingTokens: 0, costBasis: 'list', ...v }])), ...o.result });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + (o.tail || '');
}
const classify = (stdout, extra = {}) => P.classifyAttempt({ stdout, dropped: 0, sandboxState: 'completed', ...extra }, profile());

describe('KAN-113 10589: evidence must be complete and consistent', () => {
  test('a complete, consistent stream is verified', () => { const c = classify(ev()); assert.equal(c.outcome, 'verified', c.reasons.join('; ')); });
  for (const [why, stdout, extra, re] of [
    ['no init event', ev({ init: false }), {}, /init/],
    ['no assistant response (init alone cannot confirm the served model)', ev({ assistants: [] }), {}, /assistant/],
    ['no result event', ev({ result: null }), {}, /result/],
    ['truncated output', ev(), { dropped: 4096 }, /truncat/],
    ['a malformed stream line', ev({ tail: '{not json\n' }), {}, /malformed/],
    ['an unexpected Claude Code version', ev({ version: '2.1.288' }), {}, /version/],
    ['missing billing telemetry (unknown, not free)', ev({ rate: [] }), {}, /billing.*unknown/],
    ['a missing provider', ev({ usage: { [M]: { provider: undefined } } }), {}, /provider/],
  ]) {
    test(`incomplete evidence: ${why}`, () => { const c = classify(stdout, extra); assert.equal(c.outcome, 'incomplete_evidence', JSON.stringify(c)); assert.ok(c.reasons.some((r) => re.test(r)), c.reasons.join('; ')); });
  }
  for (const [why, stdout, re] of [
    ['a different model in any assistant message', ev({ assistants: [M, 'claude-sonnet-5-5'] }), /model/],
    ['a different init model', ev({ model: 'claude-sonnet-5-5' }), /model/],
    ['an unlisted extra model in modelUsage', ev({ usage: { [M]: { provider: 'firstParty' }, 'claude-haiku-5-5': { provider: 'firstParty' } } }), /model/],
    ['overage in ANY event, not only the last', ev({ rate: [{ status: 'allowed', isUsingOverage: true, overageStatus: 'allowed' }, { status: 'allowed', isUsingOverage: false, overageStatus: 'rejected' }] }), /overage/],
    ['an API-key billing route', ev({ apiKeySource: 'ANTHROPIC_API_KEY' }), /api key/i],
    ['a non-first-party provider', ev({ usage: { [M]: { provider: 'bedrock' } } }), /provider/],
  ]) {
    test(`policy violation: ${why}`, () => { const c = classify(stdout); assert.equal(c.outcome, 'policy_violation', JSON.stringify(c)); assert.ok(c.reasons.some((r) => re.test(r)), c.reasons.join('; ')); });
  }
  test('usage limit is its own outcome (a rejected rate-limit window, or an API 429)', () => {
    assert.equal(classify(ev({ rate: [{ status: 'rejected', isUsingOverage: false, overageStatus: 'rejected' }], result: { subtype: 'error_during_execution', is_error: true } })).outcome, 'usage_limit');
    assert.equal(classify(ev({ result: { subtype: 'error_during_execution', is_error: true, api_error_status: 429 } })).outcome, 'usage_limit');
  });
  test('coding timeout is its own outcome; its evidence is recorded as incomplete, never invented', () => {
    const c = classify(ev({ result: null }), { sandboxState: 'timeout' });
    assert.equal(c.outcome, 'coding_timeout'); assert.equal(c.evidence_complete, false);
  });
});

describe('KAN-113 10589: distinct outcomes through runAgentSandboxed', () => {
  const run = (stdout, extra = {}) => runAgentSandboxed('task', '/repo', { agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE],
    runSandboxed: async () => ({ status: extra.status || 'completed', diff: 'diff --git a/x b/x\n', changes: [], unsupported_changes: [], agent_stdout: stdout,
      agent_stdout_dropped: extra.dropped || 0, sandbox: { stages: { agent: { state: extra.state || 'completed', duration_ms: 5 } } } }) });
  test('preflight refusal: blocked, no sandbox', async () => {
    const r = await runAgentSandboxed('task', '/repo', { agentProfile: P.profileFromConfig(CFG) });
    assert.equal(r.status, 'blocked'); assert.equal(r.pilot_outcome, 'preflight_refused');
  });
  test('verified', async () => { const r = await run(ev()); assert.equal(r.status, 'completed'); assert.equal(r.pilot_outcome, 'verified'); });
  test('incomplete evidence stops the attempt', async () => { const r = await run(ev({ rate: [] })); assert.equal(r.status, 'infra_error'); assert.equal(r.pilot_outcome, 'incomplete_evidence'); });
  test('usage limit stops the attempt', async () => { const r = await run(ev({ result: { subtype: 'error_during_execution', is_error: true, api_error_status: 429 } })); assert.equal(r.status, 'infra_error'); assert.equal(r.pilot_outcome, 'usage_limit'); });
  test('policy violation stops the attempt', async () => { const r = await run(ev({ assistants: ['claude-sonnet-5-5'] })); assert.equal(r.status, 'infra_error'); assert.equal(r.pilot_outcome, 'policy_violation'); });
  test('coding timeout keeps the sandbox status and the patch (it may still be graded under KAN-112)', async () => {
    const r = await run(ev({ result: null }), { status: 'timeout', state: 'timeout' });
    assert.equal(r.status, 'timeout'); assert.equal(r.pilot_outcome, 'coding_timeout'); assert.match(r.diff, /diff --git/);
  });
});

describe('KAN-113 10589: profile and budget bound to the reviewed config (tamper and malformed)', () => {
  const ok = { imagePin: PIN, approved: [TEST_ROUTE] };
  test('the reviewed config names exactly the two pilot arms and their attempt limits', () => {
    assert.deepEqual(CFG.pilot_arms, { A: { qb28_arm: 'A', max_attempts: 1 }, B: { qb28_arm: 'E', max_attempts: 3 } });
  });
  for (const [field, value] of [['model', 'claude-sonnet-5-5'], ['claude_code_version', '2.1.300'], ['permission_mode', 'acceptEdits'],
    ['allowed_tools', ['Read', 'Bash', 'WebFetch']], ['disallowed_tools', []], ['agent_time_ms', 3_600_000], ['max_attempts', 9]]) {
    test(`a tampered ${field} is refused`, () => { assert.ok(P.checkProfile(profile({ [field]: value }), ok).some((e) => e.includes(field)), field); });
  }
  for (const bad of [null, {}, { model: 5 }, 'claude-opus-5-5', []]) {
    test(`a malformed profile (${JSON.stringify(bad)}) is refused`, () => { assert.ok(P.checkProfile(bad, ok).length > 0); });
  }
  test('only QB-28 arms A (1 attempt) and E (3 attempts) can run under the pilot', () => {
    assert.equal(P.budgetProblem(profile(), { agentTimeMs: 1_800_000, qb28Arm: 'A' }), null);
    assert.equal(P.budgetProblem(profile(), { agentTimeMs: 1_800_000, qb28Arm: 'E' }), null);
    for (const arm of ['B', 'C', 'D', 'F']) assert.match(P.budgetProblem(profile(), { agentTimeMs: 1_800_000, qb28Arm: arm }), /not a pilot arm/, arm);
    assert.match(P.budgetProblem(profile(), { agentTimeMs: 1_799_999, qb28Arm: 'A' }), /pilot budget/);
  });
  test('the budget is compared with the reviewed config, not with the (possibly tampered) caller profile', () => {
    const tampered = profile({ agent_time_ms: 3_600_000 });
    assert.match(P.budgetProblem(tampered, { agentTimeMs: 3_600_000, qb28Arm: 'E' }), /reviewed/);
  });
});

describe('KAN-113 10589: elapsed-time behaviour with fixtures', () => {
  let tmp; const fixtures = [];
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113h-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
  after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });
  const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s', required_behavior: ['formatDuration(30000) returns "30s"'],
    acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
    requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };
  const report = [{ type: 'qb:start', format: 'qb-node-test-events/1' },
    { type: 'test:fail', name: 'visible', nesting: 0, path: [], file: '/verify/test/a.test.js', kind: 'test', skip: false, todo: false, failureType: 'testCodeFailure', error: 'x' },
    { type: 'test:summary', file: null, counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 }, success: false }, { type: 'qb:end' }].map((e) => JSON.stringify(e)).join('\n') + '\n';
  function env() {
    const f = gradingFixture(); fixtures.push(f);
    const run = runStore.createRun({ kind: 'bench-arm', request: 'x', repoPath: f.repo.dir, baseSha: f.repo.head(), runsDir: path.join(tmp, `r${fixtures.length}`) });
    return { f, run, spec: { ...f.spec, oracle: ORACLE } };
  }
  // The stand-in honours the deadline like the container kill does: it runs min(want, deadline) and times out at the deadline
  const sandbox = (calls, wantMs) => async (o) => {
    const deadline = o.deadlines.agent; const ran = Math.min(wantMs, deadline); const timedOut = wantMs >= deadline;
    calls.push({ deadline, ran });
    return { status: timedOut ? 'timeout' : 'completed', diff: `diff --git a/src/duration.js b/src/duration.js\n--- a/src/duration.js\n+++ b/src/duration.js\n@@ -1 +1 @@\n-x\n+y${calls.length}\n`,
      changes: [{ file: 'src/duration.js', status: 'M', additions: 1, deletions: 1 }], unsupported_changes: [], agent_stdout: ev(timedOut ? { result: null } : {}), agent_stdout_dropped: 0,
      sandbox: { isolation: 'none-test-only', stages: { agent: { state: timedOut ? 'timeout' : 'completed', duration_ms: ran } },
        verification: { status: 'ran', state: 'execution_error', exit_code: 1, report, report_error: null, output: 'visible fail' } } };
  };
  test('arm E: an attempt that runs into the deadline is stopped there; the total never exceeds 1,800 s and no further attempt starts', async () => {
    const { f, run, spec } = env(); const calls = []; const m = mockFetch(ollamaReply({ met: false, evidence: 'no', repair: 'fix' }));
    try {
      const r = await runArm({ arm: 'E', spec, repoPath: f.repo.dir, run, agentTimeMs: 1_800_000, noLlmContext: true, judgeCache: path.join(tmp, 'jc'),
        agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: sandbox(calls, 1_200_000) });
      assert.deepEqual(calls, [{ deadline: 1_800_000, ran: 1_200_000 }, { deadline: 600_000, ran: 600_000 }]);
      assert.equal(r.agent_ms, 1_800_000); assert.ok(r.agent_ms <= 1_800_000);
    } finally { m.restore(); }
  });
  test('arm A: one attempt; running into the deadline is a coding timeout with the patch kept', async () => {
    const { f, run, spec } = env(); const calls = [];
    const r = await runArm({ arm: 'A', spec, repoPath: f.repo.dir, run, agentTimeMs: 1_800_000, agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: sandbox(calls, 9_999_999) });
    assert.equal(calls.length, 1); assert.equal(calls[0].ran, 1_800_000); assert.equal(r.attempts, 1); assert.match(r.patch, /diff --git/);
  });
});

describe('KAN-113 10589: exact prompt bytes and non-interactive behaviour (fake CLI)', () => {
  test('the briefing reaches `claude -p` byte for byte on stdin; argv is exactly -p + the pilot args; no TTY', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113cli-'));
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin); const work = path.join(d, 'work'); fs.mkdirSync(work);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${d}/argv"\ncat > "${d}/stdin"\n[ -t 0 ] && echo tty > "${d}/tty" || echo notty > "${d}/tty"\npwd > "${d}/cwd"\n`);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    const briefing = Buffer.from('Fix the bug.\n\nÜnïcode, "quotes", $VARS, `backticks`, --model x\n\0tail', 'utf8');
    const args = P.buildAgentArgs(profile());
    const r = spawnSync('sh', [path.join(ROOT, 'sandbox', 'agent', 'agent-run.sh'), ...args], { input: briefing, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QB_WORK_DIR: work } });
    assert.equal(r.status, 0, r.stderr.toString());
    assert.deepEqual(fs.readFileSync(path.join(d, 'stdin')), briefing, 'exact bytes');
    assert.deepEqual(fs.readFileSync(path.join(d, 'argv'), 'utf8').trimEnd().split('\n'), ['-p', ...args]);
    assert.equal(fs.readFileSync(path.join(d, 'tty'), 'utf8').trim(), 'notty');
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(d, 'cwd'), 'utf8').trim()), fs.realpathSync(work));
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('entry.sh hands over to agent-run.sh after the proxy forwarder (no prompt argument, no briefing path)', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'sandbox', 'agent', 'entry.sh'), 'utf8');
    assert.match(entry, /^exec \/usr\/local\/lib\/qb\/agent-run\.sh "\$@"$/m);
    assert.doesNotMatch(entry.split('\n').filter((l) => /^\s*exec /.test(l)).join('\n'), /briefing|\.md/, 'the exec line passes no briefing path or prompt argument');
  });
});
