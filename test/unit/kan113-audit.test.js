/**
 * KAN-113 (approved scope in 10579): per-trial audit record, pilot config and an auth-free, non-inference dry run.
 * Fixtures only: no model calls, no credentials, and `claude` is never started (a tripwire binary proves it).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', '..', 'bench', 'opus-pilot');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H64 = (c) => c.repeat(64); const H40 = (c) => c.repeat(40);
const load = () => import(path.join(DIR, 'audit.mjs'));
const loadCfg = () => import(path.join(DIR, 'config.mjs'));
const U = (r) => ({ unavailable: r });

function record(over = {}) {
  const prompt = 'Fix the bug described in the task. Make the smallest change.';
  return {
    schema: 'qb-opus-pilot-trial/1', trial_id: 'trial_0123456789abcdef', pair_id: 'pair_01234567', arm: 'A', order_in_pair: 1,
    task: { task_id: 'qbt_00b20b1b0285', dataset_revision: H40('8'), spec_sha256: H64('1'), contract_sha256: null, grader_sha256: H64('2'), base_commit: H40('4') },
    versions: { qb_commit: H40('a'), claude_code: '2.1.288', config_sha256: H64('3') },
    config: { requested_model: 'claude-opus-5-5', effort: null, tools: { allow: [], deny: ['WebFetch', 'WebSearch'] }, network: 'inference-only' },
    environment: { os: 'Ubuntu 24.04', arch: 'x86_64', cpu_model: 'fixture cpu', cpu_count: 4, ram_bytes: 17179869184, container_digests: ['sha256:' + H64('5')] },
    prompts: [{ role: 'user', sha256: sha(prompt), text: prompt }],
    transcript: { path: 'transcript.jsonl', sha256: H64('6') },
    timing: { started_at: '2026-11-13T00:00:00Z', ended_at: '2026-11-13T00:10:00Z', deadline_at: '2026-11-13T00:30:00Z' },
    attempts: [{ n: 1, patch_sha256: H64('7'), patch_bytes: 120 }],
    test_output: { path: 'test_output.txt', sha256: H64('9') },
    qb_verdict: null, independent_score: 'PASS',
    interruption: { reason: 'none', detail_sha256: null },
    model: { requested: 'claude-opus-5-5', served: { unobservable: 'no served-model field identified yet' } },
    usage: { input_tokens: U('not exposed'), output_tokens: U('not exposed'), cache_read_tokens: U('not exposed'), cache_write_tokens: U('not exposed'), reasoning_tokens: U('not exposed') },
    auxiliary_usage: [],
    human_events: [{ at: '2026-11-13T00:00:00Z', kind: 'setup', minutes: 3 }],
    billing_route: { api_key_source: 'none', provider: 'firstParty', is_using_overage: false, overage_status: 'rejected' },
    ...over,
  };
}

describe('KAN-113 audit record validator', () => {
  test('a complete fixture record is valid', async () => {
    const { validateTrialRecord } = await load();
    assert.deepEqual(validateTrialRecord(record()), []);
  });
  test('token usage is never invented: a missing or null field must be marked unavailable, with a reason', async () => {
    const { validateTrialRecord } = await load();
    const r1 = record(); delete r1.usage.output_tokens;
    assert.ok(validateTrialRecord(r1).some((e) => /output_tokens.*mark it unavailable/.test(e)));
    const r2 = record(); r2.usage.input_tokens = null;
    assert.ok(validateTrialRecord(r2).some((e) => /input_tokens/.test(e)));
    const r3 = record(); r3.usage.cache_read_tokens = { unavailable: '' };
    assert.ok(validateTrialRecord(r3).some((e) => /cache_read_tokens.*reason/.test(e)));
    const r4 = record(); r4.usage.reasoning_tokens = 1500; assert.deepEqual(validateTrialRecord(r4), [], 'a real integer count is fine');
  });
  test('anything that looks like a credential anywhere is refused, and the error never echoes it', async () => {
    const { validateTrialRecord } = await load();
    for (const secret of ['sk-ant-oat01-ABCDEFGHIJKLMNOP', 'Bearer abcdefghijklmnop123', '{"claudeAiOauth":{}}', 'ANTHROPIC_API_KEY=xyz123', 'refresh_token: abc']) {
      const errs = validateTrialRecord(record({ config: { ...record().config, network: secret } }));
      assert.ok(errs.some((e) => /credential-like/.test(e)), secret);
      assert.ok(errs.every((e) => !e.includes(secret)), 'the secret is not echoed');
    }
  });
  test('prompt text must match its recorded hash', async () => {
    const { validateTrialRecord } = await load();
    const r = record(); r.prompts[0].text += ' tampered';
    assert.ok(validateTrialRecord(r).some((e) => /prompts\[0\].*sha256/.test(e)));
  });
  test('arm rules: A has no contract and no QB verdict; B has both', async () => {
    const { validateTrialRecord } = await load();
    assert.ok(validateTrialRecord(record({ task: { ...record().task, contract_sha256: H64('c') } })).some((e) => /arm A.*contract/.test(e)));
    assert.ok(validateTrialRecord(record({ qb_verdict: 'approved' })).some((e) => /arm A.*qb_verdict/.test(e)));
    assert.ok(validateTrialRecord(record({ arm: 'B' })).some((e) => /arm B.*contract/.test(e)));
    assert.deepEqual(validateTrialRecord(record({ arm: 'B', task: { ...record().task, contract_sha256: H64('c') }, qb_verdict: 'approved' })), []);
  });
  test('served model: a real id, or an explicit unobservable marker; never empty', async () => {
    const { validateTrialRecord } = await load();
    assert.deepEqual(validateTrialRecord(record({ model: { requested: 'claude-opus-5-5', served: 'claude-opus-5-5' } })), []);
    assert.ok(validateTrialRecord(record({ model: { requested: 'claude-opus-5-5', served: '' } })).some((e) => /model.served/.test(e)));
  });
  test('cost figures are only allowed as labelled estimates', async () => {
    const { validateTrialRecord } = await load();
    assert.deepEqual(validateTrialRecord(record({ estimates: { api_equivalent_usd: { value: 1.2, label: 'estimate', basis: 'public price list on date' } } })), []);
    assert.ok(validateTrialRecord(record({ estimates: { api_equivalent_usd: { value: 1.2 } } })).some((e) => /estimate/.test(e)));
  });
  test('hidden evaluator material in a prompt is refused (reported by index, never by name)', async () => {
    const { validateTrialRecord } = await load();
    const hidden = 'Range suite > hidden failing case name';
    const text = `Fix it. Hint: ${hidden}`;
    const errs = validateTrialRecord(record({ prompts: [{ role: 'user', sha256: sha(text), text }] }), { forbidden: [hidden] });
    assert.ok(errs.some((e) => /hidden evaluator item #0/.test(e))); assert.ok(errs.every((e) => !e.includes(hidden)));
  });
  test('unknown top-level keys and bad enums are refused (no silent extras)', async () => {
    const { validateTrialRecord } = await load();
    assert.ok(validateTrialRecord(record({ notes: 'x' })).some((e) => /unknown field notes/.test(e)));
    assert.ok(validateTrialRecord(record({ independent_score: 'MOSTLY_PASS' })).some((e) => /independent_score/.test(e)));
    assert.ok(validateTrialRecord(record({ interruption: { reason: 'flaky', detail_sha256: null } })).some((e) => /interruption.reason/.test(e)));
  });
});

describe('KAN-113 pilot config (budgets and stop rules stay configurable until KAN-112 freezes them)', () => {
  const CFG = path.join(DIR, 'pilot-config.json');
  test('the committed config is frozen by KAN-112 comment 10583 (one CLI version, budgets, stop rules)', async () => {
    const { checkPilotConfig } = await loadCfg(); const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    assert.equal(c.frozen, true); assert.equal(c.frozen_by, 10583); assert.equal(c.claude_code_version, '2.1.322');
    assert.equal(c.budgets.coding_wall_clock_s, 1800); assert.equal(c.budgets.max_qb_attempts, 3);
    assert.deepEqual(checkPilotConfig(c, 'dry-run'), []);
  });
  test('live use stays refused while any arm route is unverified (arm A smoke-tested, arm B unverified)', async () => {
    const { checkPilotConfig } = await loadCfg(); const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    assert.equal(c.arm_routes.A.status, 'smoke-tested'); assert.equal(c.arm_routes.B.status, 'unverified');
    const errs = checkPilotConfig(c, 'live');
    assert.deepEqual(errs, ['arm B route is unverified: review and verify it before any paired trial']);
    const verified = { ...c, arm_routes: { ...c.arm_routes, B: { ...c.arm_routes.B, status: 'smoke-tested' } } };
    assert.deepEqual(checkPilotConfig(verified, 'live'), []);
  });
  test('an unfrozen copy is refused for live use', async () => {
    const { checkPilotConfig } = await loadCfg(); const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    assert.ok(checkPilotConfig({ ...c, frozen: false }, 'live').some((e) => /not frozen/.test(e)));
  });
  test('a "frozen" config with unset budgets or version is still refused for live use', async () => {
    const { checkPilotConfig } = await loadCfg(); const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    const errs = checkPilotConfig({ ...c, claude_code_version: null, budgets: { ...c.budgets, coding_wall_clock_s: null } }, 'live');
    assert.ok(errs.some((e) => /budgets.coding_wall_clock_s/.test(e))); assert.ok(errs.some((e) => /claude_code_version/.test(e)));
  });
  test('a config carrying a credential-like key is refused in every mode', async () => {
    const { checkPilotConfig } = await loadCfg(); const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    assert.ok(checkPilotConfig({ ...c, api_key: 'x' }, 'dry-run').some((e) => /credential/.test(e)));
  });
});

describe('KAN-113 dry run: auth-free and non-inference', () => {
  function setup(env = {}, cfgOver = {}) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113-'));
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(d, 'CLAUDE-WAS-CALLED'))}\nexit 1\n`); fs.chmodSync(path.join(bin, 'claude'), 0o755);
    const cfg = { ...JSON.parse(fs.readFileSync(path.join(DIR, 'pilot-config.json'), 'utf8')), ...cfgOver };
    fs.writeFileSync(path.join(d, 'cfg.json'), JSON.stringify(cfg));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)));
    const r = spawnSync(process.execPath, [path.join(DIR, 'dry-run.mjs'), `--config=${path.join(d, 'cfg.json')}`, `--out=${path.join(d, 'out')}`],
      { encoding: 'utf8', env: { ...clean, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env } });
    const called = fs.existsSync(path.join(d, 'CLAUDE-WAS-CALLED'));
    const plan = fs.existsSync(path.join(d, 'out', 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'out', 'plan.json'), 'utf8')) : null;
    const sample = fs.existsSync(path.join(d, 'out', 'sample-record.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'out', 'sample-record.json'), 'utf8')) : null;
    fs.rmSync(d, { recursive: true, force: true });
    return { r, called, plan, sample };
  }
  test('plans both arms without starting claude; same model and version; explicit --model; no credentials in the planned env', async () => {
    const { r, called, plan, sample } = setup();
    assert.equal(r.status, 0, r.stderr); assert.equal(called, false, 'claude was never started');
    assert.deepEqual(plan.arms.map((a) => a.arm), ['A', 'B']);
    for (const a of plan.arms) {
      assert.deepEqual(a.argv.slice(a.argv.indexOf('--model'), a.argv.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
      assert.ok(a.argv.includes('--output-format') && a.argv.includes('stream-json'));
      assert.deepEqual(Object.keys(a.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/.test(k)), []);
      assert.equal(a.executed, false);
    }
    assert.equal(plan.arms[0].claude_code_version, plan.arms[1].claude_code_version);
    assert.equal(plan.served_model, 'unverified: a dry run cannot observe which model serves a request');
    assert.equal(plan.config_frozen, true); assert.equal(plan.frozen_by, 10583);
    assert.deepEqual(plan.arms.map((a) => a.route_status), ['smoke-tested', 'unverified']);
    const { validateTrialRecord } = await load(); assert.deepEqual(validateTrialRecord(sample), [], 'the sample record validates');
  });
  test('a credential or billing-override variable in the environment stops the dry run; the value is never printed', () => {
    const { r, called } = setup({ ANTHROPIC_API_KEY: 'sk-ant-fixture-not-real-123' });
    assert.equal(r.status, 1); assert.match(r.stderr, /ANTHROPIC_API_KEY/); assert.doesNotMatch(r.stdout + r.stderr, /sk-ant-fixture/);
    assert.equal(called, false);
  });
  test('a configured Claude Code version that differs from the QB agent image pin stops the dry run', () => {
    const { r, called } = setup({}, { claude_code_version: '0.0.1' });
    assert.equal(r.status, 1); assert.match(r.stderr, /version/); assert.equal(called, false);
  });
});

// Shape of Claude Code 2.1.322 `-p --output-format stream-json --verbose` output (field names observed in the
// 2026-11-12 owner-approved smoke; values here are synthetic)
const STREAM = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', apiKeySource: 'none', claude_code_version: '2.1.322', session_id: 'fixture' },
  { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.11, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    modelUsage: { 'claude-opus-5-5': { canonicalModel: 'claude-opus-5-5', provider: 'firstParty', costBasis: 'list', costUSD: 0.11, thinkingTokens: 5, inputTokens: 10, outputTokens: 20 } } },
].map((x) => JSON.stringify(x)).join('\n') + '\n';

describe('KAN-113 extraction from Claude Code stream-json (owner-approved route, 10582)', () => {
  test('served model, usage, billing route and a labelled cost estimate come from Claude Code\'s own output', async () => {
    const { fromStreamJson } = await import(path.join(DIR, 'extract.mjs'));
    const x = fromStreamJson(STREAM);
    assert.equal(x.model.served, 'claude-opus-5-5');
    assert.deepEqual(x.usage, { input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, reasoning_tokens: 5 });
    assert.deepEqual(x.billing_route, { api_key_source: 'none', provider: 'firstParty', is_using_overage: false, overage_status: 'rejected' });
    assert.deepEqual(x.estimates, { api_equivalent_usd: { value: 0.11, label: 'estimate', basis: 'Claude Code costUSD at list price (costBasis=list); not a subscription charge' } });
    const { validateTrialRecord } = await load();
    assert.deepEqual(validateTrialRecord(record({ model: { requested: 'claude-opus-5-5', served: x.model.served }, usage: x.usage, billing_route: x.billing_route, estimates: x.estimates })), []);
  });
  test('disagreeing model reports are not resolved silently: served becomes unobservable with the reason', async () => {
    const { fromStreamJson } = await import(path.join(DIR, 'extract.mjs'));
    const x = fromStreamJson(STREAM.replace('"message":{"model":"claude-opus-5-5"', '"message":{"model":"claude-sonnet-5-5"'));
    assert.match(x.model.served.unobservable, /disagree/);
  });
  test('fields Claude Code does not report are marked unavailable, never invented', async () => {
    const { fromStreamJson } = await import(path.join(DIR, 'extract.mjs'));
    const x = fromStreamJson(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 3 } }) + '\n');
    assert.equal(x.usage.input_tokens, 3);
    assert.deepEqual(x.usage.output_tokens, { unavailable: 'not reported by Claude Code' });
    assert.ok(x.model.served.unobservable);
    assert.deepEqual(x.billing_route.api_key_source, { unavailable: 'not reported by Claude Code' });
  });
  test('an API key or overage in the billing route fails validation (no paid fallback)', async () => {
    const { validateTrialRecord } = await load();
    assert.ok(validateTrialRecord(record({ billing_route: { api_key_source: 'ANTHROPIC_API_KEY', provider: 'firstParty', is_using_overage: false, overage_status: 'rejected' } })).some((e) => /billing_route.api_key_source/.test(e)));
    assert.ok(validateTrialRecord(record({ billing_route: { api_key_source: 'none', provider: 'firstParty', is_using_overage: true, overage_status: 'allowed' } })).some((e) => /overage/.test(e)));
  });
});
