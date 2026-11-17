// KAN-112 (senior 10660): the paired axios-5892 configuration. Arm B = QB's REAL repair loop (runPipeline → orchestrate
// → execute → runAgentSandboxed) with the frozen research settings and the approved AC-4 map; arm A = the existing
// arm-A trial path. Fake Claude stream behind the runSandboxed seam; no Docker, model, network or real token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const PAIR = require('../../lib/pilot/pair');
const { runAgentSandboxed } = require('../../agent/runner');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const amendBytes = fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/amendments/amendment-1.json'));
const amendment = JSON.parse(amendBytes);

const liveEnv = { GITHUB_ACTIONS: 'true', PAIR_LIVE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'dummy-not-a-token' };
const confirmed = { paired_route: { route: 'subscription_token_env', confirmed_by: 'owner', confirmed_at: '2026-11-17', residual_risk_sha256: 'a'.repeat(64),
  drivers: ['bench/opus-pilot/pair.mjs'] } };

test('paired live route: only the paired driver, in the protected job, with the owner\'s recorded confirmation and no billing overrides', () => {
  assert.deepEqual(PAIR.routeProblems(liveEnv, '/x/bench/opus-pilot/pair.mjs', { approvals: confirmed }), []);
  assert.match(PAIR.routeProblems(liveEnv, '/x/bench/opus-pilot/arm-a.mjs', { approvals: confirmed }).join(), /paired driver/);
  assert.match(PAIR.routeProblems(liveEnv, '/x/bench/experiment-run.js', { approvals: confirmed }).join(), /paired driver/);
  assert.match(PAIR.routeProblems({ ...liveEnv, PAIR_LIVE: '' }, '/x/pair.mjs', { approvals: confirmed }).join(), /protected paired live workflow/);
  assert.match(PAIR.routeProblems({ ...liveEnv, GITHUB_ACTIONS: '' }, '/x/pair.mjs', { approvals: confirmed }).join(), /protected paired live workflow/);
  assert.match(PAIR.routeProblems({ ...liveEnv, CLAUDE_CODE_OAUTH_TOKEN: '' }, '/x/pair.mjs', { approvals: confirmed }).join(), /not set/);
  assert.match(PAIR.routeProblems(liveEnv, '/x/pair.mjs', { approvals: {} }).join(), /not confirmed/);
  assert.match(PAIR.routeProblems(liveEnv, '/x/pair.mjs', { approvals: { paired_route: { ...confirmed.paired_route, drivers: ['bench/opus-pilot/arm-a.mjs'] } } }).join(), /not confirmed/);
  // the arm-A batch-1 confirmation does NOT extend to the paired driver
  assert.match(PAIR.routeProblems(liveEnv, '/x/pair.mjs', { approvals: { auth_route: { route: 'subscription_token_env', confirmed_by: 'o', confirmed_at: 'd', residual_risk_sha256: 'a'.repeat(64) } } }).join(), /not confirmed/);
  for (const k of require('../../lib/pilot/arm-a').FORBIDDEN_ENV) assert.match(PAIR.routeProblems({ ...liveEnv, [k]: '1' }, '/x/pair.mjs', { approvals: confirmed }).join(), new RegExp(k));
});

test('production path: the paired route is refused before any sandbox when its guard fails (no seam, no Docker reached)', async () => {
  const profile = PAIR.pairProfile();
  const notes = [];
  const r = await runAgentSandboxed('Fix it.\n', '/nonexistent', { agentProfile: profile, pairedResearchRoute: true, pilot: { record: (x) => notes.push(x) } });
  assert.equal(r.status, 'blocked');
  assert.match(r.error, /pilot preflight: paired route:/);
  assert.equal(r.pilot_outcome, 'preflight_refused');
});

// fake Claude stream (same shape as the arm-A driver tests)
function stream() {
  const model = 'claude-opus-5-5';
  return [
    { type: 'system', subtype: 'init', claude_code_version: '2.1.322', model, apiKeySource: 'none', permissionMode: 'dontAsk', tools: [] },
    { type: 'assistant', message: { model, content: [{ type: 'text', text: 'done' }] } },
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', overageStatus: 'disabled', status: 'allowed', isUsingOverage: false } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, provider: 'firstParty' } } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const patchN = (n) => `diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-a\n+b${n}\n`;
const PATCH = patchN(3);
// a fake sandbox: records each call; the research verification fails AC-1 on attempts < passOn, then passes
function fakeSandbox(calls, { agentMs = 400_000, passOn = 99 } = {}) {
  return async (opts) => {
    calls.push(opts);
    const n = calls.length; const PATCH_N = patchN(n);
    return { status: 'completed', diff: PATCH_N, changes: [{ file: 'lib/x.js', status: 'M', additions: 1, deletions: 1, binary: false }], unsupported_changes: [],
      base_tree: 'b'.repeat(40), candidate_tree: `t${n}`, exit_code: 0, signal: null, stderr_tail: null, patch_raw: Buffer.from(PATCH_N), agent_stdout: stream(), agent_stdout_dropped: 0,
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
function repo() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-')); fs.writeFileSync(path.join(d, 'README.md'), 'x\n'); return d; }
const baseB = (extra) => ({ contract, repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }),
  research, preservationMaps: [], trialId: 't1', taskId: 'qbt_x', graderTask: 'axios-x', runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pair-runs-')), ...extra });

test('arm B: QB\'s real repair loop, up to 3 attempts sharing ONE 1,800 s coding allowance, research settings on every attempt', async () => {
  const calls = [];
  const r = await PAIR.runArmB(baseB({ seam: fakeSandbox(calls), approvedAuthRoutes: ['subscription_token_env'] }));
  assert.equal(calls.length, 3, 'three attempts (all failed QB verification)');
  for (const c of calls) {
    assert.equal(c.researchEnv, research.env); assert.equal(c.researchRootScripts, research.rootScripts); assert.equal(c.researchCheckRunner, research.checkRunner);
    assert.ok(Number.isFinite(c.researchDeadlineAtMs)); assert.equal(c.requireMemoryCheck, true);
    assert.deepEqual(c.checks.map((k) => k.id), ['SC-1'], 'the contract checks reach the sandbox (never the briefing)');
    assert.ok(!c.briefing.includes(SRC), 'check source is never in the briefing');
  }
  // the shared allowance: each attempt receives what remains of 1,800 s
  assert.deepEqual(calls.map((c) => c.deadlines.agent), [1_800_000, 1_400_000, 1_000_000]);
  assert.match(calls[1].briefing, /SC-1|AC-1/, 'attempt 2 carries QB repair feedback');
  assert.equal(r.attempts, 3); assert.equal(r.internal_verdict, 'fail');
  assert.equal(r.patch.toString('utf8'), PATCH, 'the LAST attempt\'s exact bytes go to the independent grader');
});

test('arm B: stops as soon as QB\'s verdict passes; no attempt once the shared allowance is spent', async () => {
  const c1 = [];
  const r1 = await PAIR.runArmB(baseB({ seam: fakeSandbox(c1, { passOn: 2 }), approvedAuthRoutes: ['subscription_token_env'] }));
  assert.equal(c1.length, 2); assert.equal(r1.internal_verdict, 'pass');
  const c2 = [];
  const r2 = await PAIR.runArmB(baseB({ seam: fakeSandbox(c2, { agentMs: 1_800_000 }), approvedAuthRoutes: ['subscription_token_env'] }));
  assert.equal(c2.length, 1, 'the first attempt used the whole allowance');
  assert.equal(r2.attempts, 1);
});

test('arm B: the approved AC-4 map reaches verify() on every attempt', async () => {
  const seen = [];
  const verifier = require('../../verify/verifier');
  const orig = verifier.verify;
  const maps = [{ map: { schema: 'qb-preservation-map/1' }, sha256: 'f'.repeat(64) }];
  await PAIR.runArmB(baseB({ seam: fakeSandbox([]), approvedAuthRoutes: ['subscription_token_env'], preservationMaps: maps,
    verifyFn: async (c, ctx, ex, o) => { seen.push(o); return orig(c, ctx, ex, o); } }));
  assert.equal(seen.length, 3);
  for (const o of seen) { assert.equal(o.preservationMaps, maps); assert.equal(o.noLlm, true); }
});

test('both arms: a briefing carrying hidden material is refused before any sandbox (hints included)', async () => {
  const calls = [];
  const vault = { FAIL_TO_PASS: '["hidden test title alpha"]', PASS_TO_PASS: '[]', patch: '', test_patch: '' };
  const r = await PAIR.runArmB(baseB({ seam: fakeSandbox(calls), approvedAuthRoutes: ['subscription_token_env'], vaultRow: vault,
    contract: approve({ ...contract, goal: 'make x work: hidden test title alpha' }, { via: 'test' }) }));
  assert.equal(calls.length, 0);
  assert.match(r.blocked || '', /briefing guard/);
});

test('arm B: QB\'s no-progress rule (an identical patch twice) stops the loop early, as in production', async () => {
  const calls = [];
  const same = fakeSandbox(calls);
  const seam = async (opts) => { const r = await same(opts); r.diff = patchN(1); r.patch_raw = Buffer.from(patchN(1)); return r; };
  const r = await PAIR.runArmB(baseB({ seam, approvedAuthRoutes: ['subscription_token_env'] }));
  assert.equal(calls.length, 2); assert.equal(r.attempts, 2);
});

test('arm A: the SAME dependency handling as arm B (reviewed root-scripts entry), and no QB verification or checks', async () => {
  const calls = [];
  const seam = async (opts) => { calls.push(opts); return { status: 'no_change', diff: null, changes: [], unsupported_changes: [], base_tree: 'b'.repeat(40), candidate_tree: 'b'.repeat(40),
    exit_code: 0, signal: null, stderr_tail: null, patch_raw: null, agent_stdout: stream(), agent_stdout_dropped: 0,
    sandbox: { credential_mode: 'K', stages: { agent: { state: 'completed', duration_ms: 10 } }, capture: { verdict: { state: 'no_change' } } } }; };
  await PAIR.runArmA({ briefing: 'Fix it.\n', repoPath: repo(), amendment, amendmentSha256: sha(amendBytes), signInAdapter: async () => ({ status: 'ok' }),
    seam, research: { rootScripts: research.rootScripts }, label: 'pair-a-dry', trialId: 't', taskId: 'qbt_x', graderTask: 'axios-x' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].researchRootScripts, research.rootScripts);
  assert.equal(calls[0].researchEnv, undefined, 'arm A gets no QB research verification');
  assert.deepEqual(calls[0].checks, [], 'arm A runs no QB checks');
});

test('briefing guard (10662): a grader test name in QB feedback is allowed ONLY if verified in the pinned visible suite', () => {
  const FILE = 'test/unit/adapters/http.js';
  const idOf = (t) => sha(`${FILE}\0${t}`);
  const vault = { FAIL_TO_PASS: JSON.stringify(['suite new hidden behaviour']), PASS_TO_PASS: JSON.stringify(['suite keeps old behaviour', 'suite added by the hidden patch']),
    patch: '+const decoded = applyTheFixHereForRealNow(value);\n', test_patch: '+  it(\'checks the hidden thing really well\', () => {});\n' };
  const g = PAIR.briefingGuard(vault, { visible: { test_files: [FILE], identities: [{ id: idOf('suite keeps old behaviour') }] } });
  assert.equal(g('QB feedback: "suite keeps old behaviour" failed'), null, 'a verified visible test name is allowed');
  assert.match(g('QB feedback: "suite added by the hidden patch" failed'), /not in the pinned visible suite/, 'a grader name NOT in the visible suite is refused');
  assert.match(g('see suite new hidden behaviour'), /fail_to_pass/, 'FAIL_TO_PASS names are always refused');
  assert.match(g('try applyTheFixHereForRealNow(value)'.replace('try ', 'const decoded = ') + ';'), /patch lines/);
  assert.match(g("it('checks the hidden thing really well', () => {});"), /patch lines/);
  // without a visible-suite record, every grader test name is refused (fail closed)
  assert.match(PAIR.briefingGuard(vault)('QB feedback: "suite keeps old behaviour" failed'), /not in the pinned visible suite/);
});

test('smoke acceptance (10662): complete served-model and subscription/billing evidence, no overage, no change — anything missing or unknown is NOT acceptable', () => {
  const ok = { primary: 'execution_verified', capture_state: 'no_change', model: { requested: 'claude-opus-5-5', served: 'claude-opus-5-5' },
    billing_route: { api_key_source: 'none', provider: 'firstParty', is_using_overage: false, overage_status: 'disabled' } };
  assert.deepEqual(PAIR.smokeProblems(ok), []);
  const bad = {
    'not verified': { ...ok, primary: 'incomplete_evidence' },
    'files changed': { ...ok, capture_state: 'captured' },
    'other model served': { ...ok, model: { ...ok.model, served: 'claude-sonnet-5-5' } },
    'served unknown': { ...ok, model: { requested: 'claude-opus-5-5', served: null } },
    'api key route': { ...ok, billing_route: { ...ok.billing_route, api_key_source: 'ANTHROPIC_API_KEY' } },
    'provider unknown': { ...ok, billing_route: { ...ok.billing_route, provider: 'not_available' } },
    'overage in use': { ...ok, billing_route: { ...ok.billing_route, is_using_overage: true } },
    'overage unknown': { ...ok, billing_route: { ...ok.billing_route, is_using_overage: 'not_available' } },
    'no billing record': { ...ok, billing_route: null },
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(PAIR.smokeProblems(s).length > 0, why);
});
