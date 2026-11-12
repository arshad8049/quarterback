/**
 * KAN-113 arm B (and the matched arm A): the pilot agent profile, structured-output verification, one shared
 * 30-minute agent deadline, and no pre-run refresh / no QB credential copy for the pilot.
 * Fixtures and stand-ins only: no Docker, no model calls, no credentials.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Claude Code 2.1.322 stream-json shape (field names observed in the 2026-11-12 smoke; synthetic values)
function stream({ model = 'claude-opus-5-5', msgModel = model, apiKeySource = 'none', overage = false, init = true } = {}) {
  return [
    init && { type: 'system', subtype: 'init', model, apiKeySource, claude_code_version: '2.1.322' },
    { type: 'assistant', message: { model: msgModel, usage: { input_tokens: 1, output_tokens: 2 } } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: overage, overageStatus: overage ? 'allowed' : 'rejected' } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 3, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      modelUsage: { [msgModel]: { canonicalModel: msgModel, provider: 'firstParty', costBasis: 'list', thinkingTokens: 0 } }, total_cost_usd: 0.01 },
  ].filter(Boolean).map((x) => JSON.stringify(x)).join('\n') + '\n';
}
const completed = (stdout, extra = {}) => ({ status: 'completed', diff: 'diff --git a/x b/x\n', changes: [], unsupported_changes: [], agent_stdout: stdout,
  sandbox: { stages: { agent: { state: 'completed', duration_ms: 1000 } } }, ...extra });

describe('KAN-113 pilot agent profile (same explicit, restricted settings in both arms)', () => {
  test('the pilot args request the frozen model, structured output and explicit restricted permissions; never bypass permissions', () => {
    const args = P.buildAgentArgs(profile());
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('--model'), 'claude-opus-5-5');
    assert.equal(at('--output-format'), 'stream-json'); assert.ok(args.includes('--verbose'));
    assert.equal(at('--permission-mode'), 'dontAsk');
    assert.equal(at('--allowed-tools'), 'Read,Glob,Grep,Edit,Write,Bash,TodoWrite');
    assert.equal(at('--disallowed-tools'), 'WebFetch,WebSearch');
    assert.ok(args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });
  test('arm A and arm B get identical agent args, version and permissions (only the briefing and QB\'s loop differ)', () => {
    assert.deepEqual(P.buildAgentArgs(profile({ arm: 'A' })), P.buildAgentArgs(profile({ arm: 'B' })));
  });
  test('the profile comes from the frozen pilot config; the auth route is NOT approved, so no pilot run can start', () => {
    const p = P.profileFromConfig(CFG);
    assert.equal(p.model, 'claude-opus-5-5'); assert.equal(p.claude_code_version, '2.1.322'); assert.equal(p.claude_code_version, PIN);
    assert.equal(p.auth_route, 'unapproved'); assert.deepEqual(P.APPROVED_AUTH_ROUTES, []);
    assert.ok(P.checkProfile(p, { imagePin: PIN }).some((e) => /auth route .* is not approved/.test(e)));
  });
  test('preflight refuses a version mismatch, a missing model, and bypass permissions', () => {
    const ok = { imagePin: PIN, approved: [TEST_ROUTE] };
    assert.deepEqual(P.checkProfile(profile(), ok), []);
    assert.ok(P.checkProfile(profile({ claude_code_version: '2.1.288' }), ok).some((e) => /version 2.1.288 .* image pin 2.1.322/.test(e)));
    assert.ok(P.checkProfile(profile({ model: '' }), ok).some((e) => /model/.test(e)));
    assert.ok(P.checkProfile(profile({ permission_mode: 'bypassPermissions' }), ok).some((e) => /permission/.test(e)));
  });
});

describe('KAN-113 runAgentSandboxed with a pilot profile', () => {
  const spy = (result) => { const calls = []; const fn = async (o) => { calls.push(o); return result; }; fn.calls = calls; return fn; };
  test('an unapproved auth route is refused BEFORE any sandbox, credential copy or pre-run refresh call', async () => {
    const fake = spy(completed(stream()));
    const r = await runAgentSandboxed('task', '/repo', { agentProfile: P.profileFromConfig(CFG), runSandboxed: fake });
    assert.equal(r.status, 'blocked'); assert.match(r.error, /auth route .* not approved/); assert.equal(fake.calls.length, 0);
  });
  test('the test-only route seam is ignored without an injected sandbox (production cannot use it)', async () => {
    const r = await runAgentSandboxed('task', '/repo', { agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE] });
    assert.equal(r.status, 'blocked'); assert.match(r.error, /not approved/);
  });
  test('a version mismatch is refused before any sandbox', async () => {
    const fake = spy(completed(stream()));
    const r = await runAgentSandboxed('task', '/repo', { agentProfile: profile({ claude_code_version: '2.1.288' }), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: fake });
    assert.equal(r.status, 'blocked'); assert.match(r.error, /version/); assert.equal(fake.calls.length, 0);
  });
  test('the sandbox receives the pilot args and a large stdout cap; a verified stream yields the agent report', async () => {
    const fake = spy(completed(stream()));
    const r = await runAgentSandboxed('task', '/repo', { agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: fake });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(fake.calls[0].agentArgs, P.buildAgentArgs(profile()));
    assert.ok(fake.calls[0].agentStdoutMaxBytes >= 8 * 1024 * 1024);
    assert.equal(r.agent_report.model.served, 'claude-opus-5-5');
    assert.deepEqual(r.agent_report.billing_route, { api_key_source: 'none', provider: 'firstParty', is_using_overage: false, overage_status: 'rejected' });
  });
  for (const [why, s, re] of [
    ['a different served model', stream({ msgModel: 'claude-sonnet-5-5' }), /served model/],
    ['an API key as the billing route', stream({ apiKeySource: 'ANTHROPIC_API_KEY' }), /api key/i],
    ['overage (paid usage) in use', stream({ overage: true }), /overage/],
    ['no structured output at all', '', /served model/],
  ]) {
    test(`verification fails closed on ${why}: the attempt is an infrastructure stop, not a result`, async () => {
      const r = await runAgentSandboxed('task', '/repo', { agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: spy(completed(s)) });
      assert.equal(r.status, 'infra_error'); assert.match(r.error, re);
    });
  }
  test('without a pilot profile, QB behaves as before (no pilot args, no verification)', async () => {
    const fake = spy(completed('plain text'));
    const r = await runAgentSandboxed('task', '/repo', { runSandboxed: fake });
    assert.equal(r.status, 'completed'); assert.equal(fake.calls[0].agentArgs, undefined); assert.equal(r.agent_report, undefined);
  });
});

describe('KAN-113 one shared 30-minute agent deadline across all attempts (frozen budget)', () => {
  let tmp; const fixtures = [];
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113b-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
  after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });
  const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s', required_behavior: ['formatDuration(30000) returns "30s"'],
    acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
    requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };
  const failing = { status: 'ran', state: 'execution_error', exit_code: 1, report: null, report_error: null, output: 'visible fail' };
  function env() {
    const f = gradingFixture(); fixtures.push(f);
    const run = runStore.createRun({ kind: 'bench-arm', request: 'x', repoPath: f.repo.dir, baseSha: f.repo.head(), runsDir: path.join(tmp, `runs-${fixtures.length}`) });
    return { f, run, spec: { ...f.spec, oracle: ORACLE } };
  }
  // Each invocation reports `agentMs` for its agent stage (no real waiting) and a verified stream
  const staged = (calls, agentMs) => async (o) => {
    calls.push({ deadline: o.deadlines && o.deadlines.agent, args: o.agentArgs });
    return completed(stream(), { diff: `diff --git a/src/duration.js b/src/duration.js\n--- a/src/duration.js\n+++ b/src/duration.js\n@@ -1 +1 @@\n-x\n+y${calls.length}\n`,
      changes: [{ file: 'src/duration.js', status: 'M', additions: 1, deletions: 1 }],
      sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'completed', duration_ms: agentMs } }, verification: failing } });
  };
  const BUDGET = CFG.budgets.coding_wall_clock_s * 1000;
  test('the frozen budget is 1,800,000 ms and QB gets at most 3 attempts', () => { assert.equal(BUDGET, 1_800_000); assert.equal(CFG.budgets.max_qb_attempts, 3); });
  for (const arm of ['B', 'E']) {
    test(`arm ${arm}: three attempts share one 30-minute budget (deadlines 30, 20, 10 min), not 30 minutes each`, async () => {
      const { f, run, spec } = env(); const calls = []; const m = mockFetch(ollamaReply({ met: false, evidence: 'no', repair: 'fix' }));
      try {
        const r = await runArm({ arm, spec, repoPath: f.repo.dir, run, agentTimeMs: BUDGET, noLlmContext: true, judgeCache: path.join(tmp, 'jc'),
          agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: staged(calls, 600_000) });
        assert.deepEqual(calls.map((c) => c.deadline), [1_800_000, 1_200_000, 600_000]);
        assert.equal(r.agent_ms, 1_800_000, 'the total across all attempts equals ONE budget');
        assert.ok(calls.every((c) => JSON.stringify(c.args) === JSON.stringify(P.buildAgentArgs(profile()))), 'every attempt gets the pilot args');
      } finally { m.restore(); }
    });
    test(`arm ${arm}: once the shared budget is spent, no further attempt starts`, async () => {
      const { f, run, spec } = env(); const calls = []; const m = mockFetch(ollamaReply({ met: false, evidence: 'no', repair: 'fix' }));
      try {
        const r = await runArm({ arm, spec, repoPath: f.repo.dir, run, agentTimeMs: BUDGET, noLlmContext: true, judgeCache: path.join(tmp, 'jc'),
          agentProfile: profile(), approvedAuthRoutes: [TEST_ROUTE], runSandboxed: staged(calls, 1_000_000) });
        assert.deepEqual(calls.map((c) => c.deadline), [1_800_000, 800_000]); assert.equal(r.attempts, 2);
      } finally { m.restore(); }
    });
  }
});

describe('KAN-113 container entry and pipeline wiring', () => {
  test('the agent entrypoint hard-codes no flags; QB\'s legacy flags are the default only when no pilot args are given', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'sandbox', 'agent', 'entry.sh'), 'utf8');
    assert.match(entry, /^exec claude -p "\$@"$/m);
    const { agentTailArgs, DEFAULT_AGENT_ARGS } = require('../../lib/sandbox/agent');
    assert.deepEqual(DEFAULT_AGENT_ARGS, ['--dangerously-skip-permissions', '--output-format', 'text']);
    assert.deepEqual(agentTailArgs({}), DEFAULT_AGENT_ARGS);
    assert.deepEqual(agentTailArgs({ agentArgs: ['--model', 'm'] }), ['--model', 'm']);
  });
  test('the experiment runner takes the agent profile from the pinned manifest config', () => {
    const { agentProfileFromManifest } = require('../../bench/experiment-run');
    assert.equal(agentProfileFromManifest({ config: {} }), null);
    assert.deepEqual(agentProfileFromManifest({ config: { agent_profile: profile() } }), profile());
  });
});
