// KAN-117 review 10620, slice A: research-only Mocha channel for axios-4738/4731.
// Everything here is fake: no Docker, no model, no network, no benchmark answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..', '..');
const E = require('../../lib/research/dataset-env');
const M = require('../../verify/mocha-report');
const V = require('../../lib/research/verify-stage');
const ENV = (k) => JSON.parse(fs.readFileSync(path.join(ROOT, `bench/opus-pilot/mocha/${k}.env.json`), 'utf8'));
const JEST_ENV = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/task-2005.env.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── env records ──
test('both axios env records validate: exact Mocha version, explicit files, disclosed omissions; Jest /1 is unchanged', () => {
  for (const k of ['axios-4738', 'axios-4731']) {
    const e = ENV(k);
    assert.doesNotThrow(() => E.validateTaskEnv(e));
    assert.equal(e.mocha_version, '8.4.0');
    assert.equal(e.probe.expect.mocha, e.mocha_version);
    assert.equal(e.test_files.length, 6);
    assert.ok(e.omitted.length >= 3);
    assert.equal(e.exposure, 'calibration', 'answer-exposed by batch 1: never untouched paired evidence');
  }
  assert.doesNotThrow(() => E.validateTaskEnv(JEST_ENV));
  assert.throws(() => E.validateTaskEnv({ ...JEST_ENV, runner: 'mocha' }), /task env/, 'schema /1 stays Jest-only');
});

test('a Mocha env record is refused for a version range, globbed/unsafe files, missing --no-config/--no-package, extra flags or no disclosure', () => {
  const g = ENV('axios-4738');
  for (const [why, patch] of [
    ['range', { mocha_version: '^8.2.1' }],
    ['probe disagrees', { probe: { ...g.probe, expect: { mocha: '8.3.0' } } }],
    ['glob', { test_files: ['test/unit/**/*.js'] }],
    ['traversal', { test_files: ['../x.js'] }],
    ['absolute', { test_files: ['/verify/test/x.js'] }],
    ['no files', { test_files: [] }],
    ['no --no-config', { test_argv: g.test_argv.filter((a) => a !== '--no-config') }],
    ['no --no-package', { test_argv: g.test_argv.filter((a) => a !== '--no-package') }],
    ['own reporter', { test_argv: [...g.test_argv, '--reporter', 'spec'] }],
    ['require hook', { test_argv: [...g.test_argv, '--require', 'x.js'] }],
    ['config file', { test_argv: [...g.test_argv, '--config', '.mocharc.json'] }],
    ['not mocha bin', { test_argv: ['npm', 'test'] }],
    ['no omissions disclosed', { omitted: [] }],
    ['list step', { list_argv: ['node', 'x'] }],
  ]) assert.throws(() => E.validateTaskEnv({ ...g, ...patch }), /task env/, why);
});

test('ordinary QB runs still validate only node:test (the Mocha channel is research-only)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'context/test-plan.js'), 'utf8');
  assert.match(src, /const VALIDATED = new Set\(\['node-test'\]\);/);
});

// ── the reporter, driven by a fake Mocha runner ──
const REPORTER = path.join(ROOT, 'sandbox/research/qb-mocha-reporter.cjs');
function fakeRun(script, { nonce = 'n0nce', mochaVersion = '8.4.0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbm-'));
  const out = path.join(dir, 'r.ndjson');
  const Reporter = require(REPORTER);
  const runner = new EventEmitter();
  runner.stats = { suites: 0, tests: 0, passes: 0, pending: 0, failures: 0 };
  // eslint-disable-next-line no-new
  new Reporter(runner, { reporterOptions: { output: out, nonce, mocha_version: mochaVersion } });
  const T = (file, title, type = 'test') => ({ file, type, title, fullTitle: () => title });
  script(runner, T);
  return { text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, out };
}
const F = '/verify/test/unit/a.js';
const normal = (r, T) => {
  r.emit('start');
  r.emit('suite', { file: F, root: false });
  const a = T(F, 'a works'); r.emit('pass', a); r.stats.passes++; r.stats.tests++;
  const b = T(F, 'b skipped'); r.emit('pending', b); r.stats.pending++; r.stats.tests++;
  r.emit('end');
};

test('reporter: complete current-run report with nonce, Mocha version, per-test lines and the runner stats; no test names hashed away by the validator', () => {
  const { text } = fakeRun(normal);
  const lines = text.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'qb:start'); assert.equal(lines[0].format, M.FORMAT); assert.equal(lines[0].nonce, 'n0nce'); assert.equal(lines[0].mocha_version, '8.4.0');
  assert.equal(lines.at(-1).type, 'qb:end'); assert.deepEqual(lines.at(-1).stats, { suites: 0, tests: 2, passes: 1, pending: 1, failures: 0 });
  assert.deepEqual(lines.filter((l) => l.type === 'test').map((l) => l.state), ['passed', 'pending']);
});

test('reporter: a hook failure is its own line (never a passing test)', () => {
  const { text } = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('fail', T(F, '"before all" hook', 'hook'), new Error('x')); r.stats.failures++; r.emit('end'); });
  assert.ok(text.split('\n').filter(Boolean).map(JSON.parse).some((l) => l.type === 'hook_fail'));
});

// ── the validator ──
const ROOTDIR = '/verify';
const FILES = ['test/unit/a.js'];
const ok = (o = {}) => ({ reportText: fakeRun(normal).text, exitCode: 0, startedAtMs: 0, nonce: 'n0nce', root: ROOTDIR, files: FILES, mochaVersion: '8.4.0', ...o });

test('validator: a complete, current, consistent run passes; identities are hashes (no test names in the result)', () => {
  const v = M.validateMochaRun(ok());
  assert.equal(v.verdict, 'passed', JSON.stringify(v.reasons));
  assert.deepEqual(v.counts, { total: 2, passed: 1, failed: 0, pending: 1, hook_failures: 0, files: 1 });
  assert.ok(!JSON.stringify(v).includes('a works'));
  assert.ok(v.identities.some((x) => x.id === sha('test/unit/a.js\0a works')));
  assert.match(v.identity_set_sha256, /^[0-9a-f]{64}$/);
});

test('validator: a real failing test is failed; exit code must agree', () => {
  const t = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('pass', T(F, 'p')); r.stats.passes++; r.stats.tests++; r.emit('fail', T(F, 'f'), new Error('boom')); r.stats.failures++; r.stats.tests++; r.emit('end'); }).text;
  assert.equal(M.validateMochaRun(ok({ reportText: t, exitCode: 1 })).verdict, 'failed');
  const contradiction = M.validateMochaRun(ok({ reportText: t, exitCode: 0 }));
  assert.equal(contradiction.verdict, 'error'); assert.ok(contradiction.reasons.includes('exit_contradicts_report'));
  assert.ok(M.validateMochaRun(ok({ exitCode: 3 })).reasons.includes('exit_contradicts_report'));
});

test('validator: never PASS for zero, missing, truncated, corrupt, stale, foreign, forged, hook-failed or version-mismatched evidence', () => {
  const good = fakeRun(normal).text;
  const zero = fakeRun((r) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('end'); }).text;
  const hook = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('pass', T(F, 'p')); r.stats.passes++; r.stats.tests++; r.emit('fail', T(F, '"after all" hook', 'hook'), new Error('x')); r.stats.failures++; r.emit('end'); }).text;
  const L = good.trim().split('\n');
  const cases = {
    no_report: [{ reportText: null }, 'no_report'],
    zero_tests: [{ reportText: zero }, 'zero_tests'],
    truncated: [{ reportText: `${L.slice(0, -1).join('\n')}\n` }, 'incomplete_report'],
    no_newline: [{ reportText: good.slice(0, -1) }, 'incomplete_report'],
    corrupt: [{ reportText: `${L[0]}\n{not json\n${L.slice(1).join('\n')}\n` }, 'malformed_report'],
    stale: [{ startedAtMs: Date.now() + 3_600_000 }, 'stale_report'],
    foreign_nonce: [{ nonce: 'other' }, 'nonce_mismatch'],
    forged_append: [{ reportText: `${good}${L.at(-1)}\n` }, 'malformed_report'],
    forged_start: [{ reportText: `${L[0]}\n${good}` }, 'malformed_report'],
    inconsistent: [{ reportText: good.replace('"passes":1', '"passes":2') }, 'inconsistent_counts'],
    hook_failure: [{ reportText: hook, exitCode: 1 }, 'hook_failure'],
    discovery: [{ files: ['test/unit/a.js', 'test/unit/b.js'] }, 'discovery_mismatch'],
    outside_root: [{ root: '/scratch' }, 'malformed_report'],
    version: [{ mochaVersion: '8.3.0' }, 'mocha_version_mismatch'],
  };
  for (const [name, [patch, reason]] of Object.entries(cases)) {
    const v = M.validateMochaRun(ok(patch));
    assert.notEqual(v.verdict, 'passed', name);
    assert.ok(v.reasons.includes(reason), `${name}: ${JSON.stringify(v.reasons)}`);
  }
});

test('validator: with a base baseline, missing, unexpected and skip-drifted tests are errors (identity, not count)', () => {
  const base = M.baselineFrom(M.validateMochaRun(ok()));
  assert.equal(M.validateMochaRun(ok({ baseline: base })).verdict, 'passed');
  const only = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('pass', T(F, 'a works')); r.stats.passes++; r.stats.tests++; r.emit('end'); }).text;
  assert.ok(M.validateMochaRun(ok({ reportText: only, baseline: base })).reasons.includes('missing_executions'));
  const renamed = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('pass', T(F, 'a works')); r.emit('pass', T(F, 'c new')); r.stats.passes += 2; r.emit('pending', T(F, 'b skipped')); r.stats.pending++; r.stats.tests += 3; r.emit('end'); }).text;
  assert.ok(M.validateMochaRun(ok({ reportText: renamed, baseline: base })).reasons.includes('unexpected_tests'));
  const unskipped = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('pass', T(F, 'a works')); r.emit('pass', T(F, 'b skipped')); r.stats.passes += 2; r.stats.tests += 2; r.emit('end'); }).text;
  assert.ok(M.validateMochaRun(ok({ reportText: unskipped, baseline: base })).reasons.includes('status_drift'));
  assert.throws(() => M.baselineFrom({ verdict: 'error' }), /baseline/);
});

test('validator: a base run with existing failures still yields a recorded (failed) baseline, reported honestly', () => {
  const t = fakeRun((r, T) => { r.emit('start'); r.emit('suite', { file: F }); r.emit('pass', T(F, 'p')); r.stats.passes++; r.stats.tests++; r.emit('fail', T(F, 'f'), new Error('boom')); r.stats.failures++; r.stats.tests++; r.emit('end'); }).text;
  const v = M.validateMochaRun(ok({ reportText: t, exitCode: 1 }));
  const b = M.baselineFrom(v);
  assert.equal(b.base_verdict, 'failed'); assert.equal(b.counts.failed, 1);
});

// ── the research stage, Mocha branch, with a fake Docker ──
function fakeDocker(script) {
  const calls = []; let now = 0; const files = new Map();
  return {
    calls, files, clock: () => now,
    runStage: async (name, args, opts) => {
      calls.push({ name, args, timeout: opts.waitTimeoutMs });
      const r = script(name, args, now) || {};
      now += r.ms || 1000;
      if (r.file) files.set(`${name}:${r.file.path}`, r.file.text);
      return { name, state: r.state || 'completed', exit_code: r.exit ?? 0, reason: null, stdout: r.stdout || '', stderr: '', duration_ms: r.ms || 1000, oom_killed: false };
    },
    readFile: async (c, f) => (files.has(`${c}:${f}`) ? files.get(`${c}:${f}`) : null),
  };
}
const WS = { runId: 'qb-test', image: 'tools-img', mount: (n, ro) => ['-v', `${n}${ro ? ':ro' : ''}`] };
const PROBE = JSON.stringify({ node: 'v24.0.0', ci: null, mocha: '8.4.0' });
function reportFor(env, nonce, outPath, { fail = false } = {}) {
  const lines = [{ type: 'qb:start', format: M.FORMAT, nonce, mocha_version: '8.4.0', started_at: Date.now() }];
  let passes = 0; let failures = 0;
  for (const f of env.test_files) {
    lines.push({ type: 'suite', file: `/verify/${f}` });
    lines.push({ type: 'test', file: `/verify/${f}`, full_title: `t ${f}`, state: fail ? 'failed' : 'passed' });
    if (fail) failures++; else passes++;
  }
  lines.push({ type: 'qb:end', stats: { suites: 0, tests: env.test_files.length, passes, pending: 0, failures } });
  return { path: outPath, text: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' };
}
const happy = (env, o = {}) => (name, args) => {
  if (name.endsWith('-verify-prep')) return { file: { path: '/out/verify-prep.json', text: '{"status":"ready","tree":"t","protected_modified":[]}' } };
  if (name.endsWith('-r-probe')) return { stdout: o.probe || PROBE };
  if (name.endsWith('-r-test')) {
    const i = args.indexOf('--reporter-option'); const opts = Object.fromEntries(args[i + 1].split(',').map((kv) => kv.split('=')));
    return { file: reportFor(env, opts.nonce, opts.output, o), exit: o.fail ? 6 : 0, state: o.fail ? 'execution_error' : 'completed', ms: o.ms };
  }
  return {};
};

test('stage (mocha): no list step, fixed argv + explicit files, QB reporter bind-mounted read-only with its sha, fresh nonce and output per run', async () => {
  const env = ENV('axios-4738');
  const d = fakeDocker(happy(env));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d, now: d.clock, image: 'agent-img' });
  assert.equal(r.status, 'ran'); assert.equal(r.verdict, 'passed', JSON.stringify(r.reasons));
  assert.deepEqual(d.calls.map((c) => c.name.replace('qb-test-', '')), ['verify-prep', 'r-probe', 'r-test']);
  assert.ok(d.calls[0].args.includes(`QB_PROTECTED=${env.protected.join('\n')}`));
  const t = d.calls.at(-1).args;
  const img = t.indexOf('agent-img');
  assert.deepEqual(t.slice(img + 1, img + 1 + env.test_argv.length - 1), env.test_argv.slice(1));
  for (const f of env.test_files) assert.ok(t.includes(f), f);
  assert.ok(t.some((a) => /^.+qb-mocha-reporter\.cjs:\/opt\/qb-research\/qb-mocha-reporter\.cjs:ro$/.test(a)), 'reporter bind mount is read-only');
  assert.equal(t[t.indexOf('--reporter') + 1], '/opt/qb-research/qb-mocha-reporter.cjs');
  assert.match(t[t.indexOf('--reporter-option') + 1], /^output=\/out\/qb-mocha-[0-9a-f]{32}\.ndjson,nonce=[0-9a-f]{32},mocha_version=8\.4\.0$/);
  assert.equal(r.reporter.sha256, sha(fs.readFileSync(REPORTER)));
  assert.equal(r.reporter.source, 'bind-mount (read-only) from the QB checkout; agent image unchanged');
  for (const c of d.calls) assert.ok(!c.args.some((a) => /^CI=/.test(a)), `${c.name} sets CI`);
  const d2 = fakeDocker(happy(env)); await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d2, now: d2.clock, image: 'agent-img' });
  const opt = (x) => x.calls.at(-1).args[x.calls.at(-1).args.indexOf('--reporter-option') + 1];
  assert.notEqual(opt(d), opt(d2), 'a fresh output path and nonce per run');
});

test('stage (mocha): failing tests are failed (not error); timeout is stage_timeout; probe mismatch stops before the test', async () => {
  const env = ENV('axios-4731');
  let d = fakeDocker(happy(env, { fail: true }));
  assert.equal((await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d, now: d.clock, image: 'i' })).verdict, 'failed');
  d = fakeDocker(happy(env, { ms: env.internal_stage_cap_ms + 1 }));
  assert.equal((await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d, now: d.clock, image: 'i' })).verdict, 'stage_timeout');
  d = fakeDocker(happy(env, { probe: JSON.stringify({ node: 'v24', ci: null, mocha: '10.0.0' }) }));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d, now: d.clock, image: 'i' });
  assert.equal(r.verdict, 'error'); assert.ok(r.reasons.includes('probe_mismatch'));
  assert.ok(!d.calls.some((c) => c.name.endsWith('-r-test')));
});

test('stage (mocha): a report under a different nonce or a missing report is never PASS', async () => {
  const env = ENV('axios-4738');
  const base = happy(env);
  let d = fakeDocker((n, a, now) => { const r = base(n, a, now); if (n.endsWith('-r-test')) r.file.text = r.file.text.replace(/"nonce":"[0-9a-f]+"/, '"nonce":"deadbeef"'); return r; });
  let r = await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d, now: d.clock, image: 'i' });
  assert.equal(r.verdict, 'error'); assert.ok(r.reasons.includes('nonce_mismatch'));
  d = fakeDocker((n, a, now) => { const x = base(n, a, now); if (n.endsWith('-r-test')) delete x.file; return x; });
  r = await V.runResearchVerification(WS, { status: 'ready' }, env, { docker: d, now: d.clock, image: 'i' });
  assert.equal(r.verdict, 'error'); assert.ok(r.reasons.includes('no_report'));
});
