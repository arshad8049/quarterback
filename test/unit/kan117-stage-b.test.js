// KAN-117 stage B (review 10607): research-only dataset-native verification for immutable-js 2005.
// Everything here is fake: no Docker, no model, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENV = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/task-2005.env.json'), 'utf8'));
const E = require('../../lib/research/dataset-env');
const J = require('../../verify/jest-report');
const V = require('../../lib/research/verify-stage');

// ── env record ──
test('the committed task env record validates; malformed records are refused', () => {
  assert.doesNotThrow(() => E.validateTaskEnv(ENV));
  for (const bad of [
    { ...ENV, runner: 'mocha' },
    { ...ENV, env_unset: [] },
    { ...ENV, pre_steps: [{ name: 'x', argv: 'npm run x' }] },
    { ...ENV, test_argv: ['node', 'jest', '--outputFile=/tmp/x.json'] },
    { ...ENV, internal_stage_cap_ms: 0 },
    { ...ENV, generated_paths: ['/abs/'] },
    { ...ENV, exposure: undefined },
  ]) assert.throws(() => E.validateTaskEnv(bad), /task env/);
});

test('the agent notice states the same command and rules for every arm', () => {
  const n = E.agentNotice(ENV);
  assert.match(n, /identical for every arm/);
  assert.match(n, /CI environment variable unset/);
  assert.match(n, /dist\/ or npm\//);
});

// ── generated paths (decision 2) ──
test('generated paths: new untracked files, tracked edits and tracked deletions are all refused and classified', () => {
  const f = E.generatedPathFindings([
    { file: 'src/Map.js', status: 'M' },
    { file: 'dist/immutable.js', status: 'A' },
    { file: 'npm/package.json', status: 'M' },
    { file: 'dist/old.js', status: 'D' },
    { file: 'distribution/x.js', status: 'A' },
  ], ENV.generated_paths);
  assert.deepStrictEqual(f, [
    { file: 'dist/immutable.js', status: 'A', kind: 'new_untracked' },
    { file: 'npm/package.json', status: 'M', kind: 'tracked_edit' },
    { file: 'dist/old.js', status: 'D', kind: 'tracked_delete' },
  ]);
  assert.deepStrictEqual(E.generatedPathFindings([{ file: 'src/x.js', status: 'A' }], ENV.generated_paths), []);
});

// ── Jest report validator ──
const R = '/verify';
const asr = (fullName, status, line = 1) => ({ fullName, title: fullName, ancestorTitles: [], status, location: { line, column: 1 } });
function report(files, { success, start = 1_000_000, runtimeErrors = 0 } = {}) {
  const all = files.flatMap((f) => f.tests);
  const n = (s) => all.filter((t) => t.status === s).length;
  return JSON.stringify({
    numTotalTests: all.length, numPassedTests: n('passed'), numFailedTests: n('failed'), numPendingTests: n('pending'), numTodoTests: n('todo'),
    numRuntimeErrorTestSuites: runtimeErrors, numTotalTestSuites: files.length, startTime: start,
    success: success ?? (n('failed') === 0 && runtimeErrors === 0),
    testResults: files.map((f) => ({ name: `${R}/${f.file}`, status: f.tests.some((t) => t.status === 'failed') ? 'failed' : 'passed', assertionResults: f.tests })),
  });
}
const FILES = () => [
  { file: '__tests__/List.ts', tests: [asr('List remove removes any index', 'passed'), asr('List remove removes any index', 'passed'), asr('List push', 'passed')] },
  { file: '__tests__/MultiRequire.js', tests: [asr('MultiRequire a', 'passed'), asr('MultiRequire skip', 'pending')] },
];
const list = (files) => JSON.stringify(files.map((f) => `${R}/${f.file}`));
const run = (files, o = {}) => J.validateJestRun({ reportText: report(files, o), listText: list(o.listed || files), exitCode: o.exit ?? (report(files, o).includes('"success":true') ? 0 : 1), startedAtMs: 1_000_000, root: R, baseline: o.baseline || null });

test('a clean run passes, keeps duplicate identities as a multiset, and yields a baseline', () => {
  const v = run(FILES());
  assert.strictEqual(v.verdict, 'passed', v.reasons.join(';'));
  assert.strictEqual(v.counts.total, 5);
  const dup = v.identities.find((x) => x.count === 2);
  assert.ok(dup && dup.statuses.join() === 'passed,passed', 'it.each duplicate grouped, never deduplicated');
  assert.ok(!JSON.stringify(v.identities).includes('remove removes'), 'identities are hashed, not named');
  const b = J.baselineFrom(v);
  assert.strictEqual(run(FILES(), { baseline: b }).verdict, 'passed');
});

test('a correctly parsed failing suite is failed, not error', () => {
  const b = J.baselineFrom(run(FILES()));
  const f = FILES(); f[0].tests[2] = asr('List push', 'failed');
  const v = run(f, { baseline: b });
  assert.strictEqual(v.verdict, 'failed');
  assert.deepStrictEqual(v.reasons, []);
});

test('fail closed: malformed, truncated, stale, zero tests, runtime errors, discovery mismatch, exit contradiction', () => {
  const ok = FILES();
  const cases = [
    [J.validateJestRun({ reportText: '{"num', listText: list(ok), exitCode: 0, startedAtMs: 1_000_000, root: R }), 'malformed_report'],
    [J.validateJestRun({ reportText: null, listText: list(ok), exitCode: 0, startedAtMs: 1_000_000, root: R }), 'no_report'],
    [run(ok, { start: 1 }), 'stale_report'],
    [run([{ file: '__tests__/A.ts', tests: [] }]), 'zero_tests'],
    [run(ok, { runtimeErrors: 1, success: false }), 'runtime_error_suite'],
    [run(ok, { listed: [...ok, { file: '__tests__/Extra.ts', tests: [] }] }), 'discovery_mismatch'],
    [run(ok, { exit: 1 }), 'exit_contradicts_report'],
    [J.validateJestRun({ reportText: report(ok), listText: 'not json', exitCode: 0, startedAtMs: 1_000_000, root: R }), 'malformed_list'],
  ];
  for (const [v, reason] of cases) {
    assert.strictEqual(v.verdict, 'error', reason);
    assert.ok(v.reasons.includes(reason), `${reason} not in ${v.reasons}`);
  }
});

test('baseline identity check: a missing execution is an error even when extras keep the count up; pending must stay pending', () => {
  const b = J.baselineFrom(run(FILES()));
  const missing = FILES(); missing[0].tests.splice(0, 1, asr('Brand new', 'passed'));
  const v = run(missing, { baseline: b });
  assert.strictEqual(v.counts.total, 5);
  assert.strictEqual(v.verdict, 'error');
  assert.ok(v.reasons.includes('missing_executions') && v.reasons.includes('unexpected_tests'));
  const drift = FILES(); drift[1].tests[1] = asr('MultiRequire skip', 'passed');
  assert.ok(run(drift, { baseline: b }).reasons.includes('status_drift'));
});

// ── the verification stage: sequencing, ONE shared cap, separate failures, fresh output ──
function fakeDocker(script) {
  const calls = [];
  let now = 0;
  const files = new Map();
  return {
    calls, files, clock: () => now,
    runStage: async (name, args, opts) => {
      calls.push({ name, args, timeout: opts.waitTimeoutMs });
      const r = script(name, args, opts) || {};
      now += r.ms || 1000;
      if (r.file) files.set(`${name}:${r.file.path}`, r.file.text);
      return { name, state: r.state || 'completed', exit_code: r.exit ?? 0, reason: r.reason || null, stdout: r.stdout || '', stderr: '', duration_ms: r.ms || 1000, oom_killed: false };
    },
    readFile: async (container, file) => (files.has(`${container}:${file}`) ? files.get(`${container}:${file}`) : null),
  };
}
const WS = { runId: 'qb-test', mount: (n, ro) => ['-v', `${n}${ro ? ':ro' : ''}`] };
const PROBE_OK = JSON.stringify({ node: 'v24.0.0', npm: '11.0.0', npm_ignore_scripts: 'false', ci: null, jest: '29.6.4', resolved: '/verify/src/Immutable.js' });
const happy = (startMs = 0) => (name, args) => {
  if (name.endsWith('-verify-prep')) return { file: { path: '/out/verify-prep.json', text: '{"status":"ready","tree":"t","protected_modified":[]}' } };
  if (name.endsWith('-r-probe')) return { stdout: PROBE_OK };
  if (name.endsWith('-r-list')) return { stdout: list(FILES()) };
  if (name.endsWith('-r-test')) {
    const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    return { file: { path: out, text: report(FILES(), { start: startMs }) } };
  }
  return {};
};

test('stage: protected list reaches verify-prep, CI is never set, steps share one cap, the report path is fresh', async () => {
  const d = fakeDocker(happy(0));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: d.clock, image: 'agent-img' });
  assert.strictEqual(r.status, 'ran'); assert.strictEqual(r.verdict, 'passed', JSON.stringify(r.reasons));
  const prep = d.calls[0];
  assert.ok(prep.args.includes(`QB_PROTECTED=${ENV.protected.join('\n')}`));
  for (const c of d.calls) assert.ok(!c.args.some((a) => /^CI=/.test(a) || /NODE_OPTIONS=.*test-reporter/.test(a)), `${c.name} sets CI or node:test reporter`);
  const names = d.calls.map((c) => c.name.replace('qb-test-', ''));
  assert.deepStrictEqual(names, ['verify-prep', 'r-probe', 'r-build-clean', 'r-build-dist', 'r-build-types', 'r-build-prepare', 'r-list', 'r-test']);
  const timeouts = d.calls.slice(1).map((c) => c.timeout);
  for (let i = 1; i < timeouts.length; i++) assert.ok(timeouts[i] < timeouts[i - 1], 'remaining time shrinks: one shared cap');
  assert.ok(timeouts[0] <= ENV.internal_stage_cap_ms);
  const out = d.calls.at(-1).args.find((a) => a.startsWith('--outputFile='));
  assert.match(out, /^--outputFile=\/out\/qb-jest-[0-9a-f]{32}\.json$/);
  assert.strictEqual(r.probe.resolved, '/verify/src/Immutable.js');
});

test('stage: a remaining trial deadline below the cap bounds the stage', async () => {
  const d = fakeDocker(happy(0));
  await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: d.clock, image: 'i', deadlineAtMs: 120_000 });
  assert.ok(d.calls[1].timeout <= 120_000);
});

test('stage: a failing build step stops with build_failed and names the step; later steps never run', async () => {
  const base = happy(0);
  const d = fakeDocker((n, a) => (n.endsWith('-r-build-dist') ? { exit: 1, state: 'execution_error' } : base(n, a)));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: d.clock, image: 'i' });
  assert.strictEqual(r.status, 'ran'); assert.strictEqual(r.verdict, 'build_failed'); assert.strictEqual(r.failed_step, 'build:dist');
  assert.ok(!d.calls.some((c) => c.name.endsWith('-r-test')));
});

test('stage: cap exhausted is a timeout of the internal stage, not a test failure', async () => {
  const base = happy(0);
  const d = fakeDocker((n, a) => (n.endsWith('-r-build-clean') ? { ms: ENV.internal_stage_cap_ms + 1 } : base(n, a)));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: d.clock, image: 'i' });
  assert.strictEqual(r.verdict, 'stage_timeout');
});

test('stage: probe mismatch (CI set, src not resolved, Jest version) is a harness error before any test', async () => {
  for (const bad of [{ ci: '1' }, { resolved: '/verify/dist/immutable.js' }, { jest: '27.2.0' }]) {
    const base = happy(0);
    const d = fakeDocker((n, a) => (n.endsWith('-r-probe') ? { stdout: JSON.stringify({ ...JSON.parse(PROBE_OK), ...bad }) } : base(n, a)));
    const r = await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: d.clock, image: 'i' });
    assert.strictEqual(r.verdict, 'error'); assert.ok(r.reasons.includes('probe_mismatch'), JSON.stringify(bad));
    assert.ok(!d.calls.some((c) => c.name.endsWith('-r-build-clean')));
  }
});

test('stage: a stale/prewritten report (startTime before the run) is rejected', async () => {
  const d = fakeDocker(happy(-60_000));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: () => 60_000 + d.clock(), image: 'i' });
  assert.strictEqual(r.verdict, 'error'); assert.ok(r.reasons.includes('stale_report'));
});

test('stage: dependency change or prep failure means not run (never a test verdict)', async () => {
  const d = fakeDocker((n) => (n.endsWith('-verify-prep') ? { file: { path: '/out/verify-prep.json', text: '{"status":"dependency_change_required","changed":["package.json"]}' } } : {}));
  const r = await V.runResearchVerification(WS, { status: 'ready' }, ENV, { docker: d, now: d.clock, image: 'i' });
  assert.deepStrictEqual([r.status, r.reason], ['not_run', 'dependency_change_required']);
});

// ── customer default unchanged (G0/G1) ──
test('the customer CLI still refuses an unsupported runner; testPlan still says unsupported for jest', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan117-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '29' }, scripts: { test: 'jest' } }));
  assert.strictEqual(require('../../context/test-plan').testPlan(dir).reason, 'unsupported_runner');
  const { errors } = require('../../lib/run-options').validateRunOptions({ agent: 'manual', repo: dir }, 'x');
  assert.ok(errors.some((e) => /unsupported test runner: jest/.test(e)));
});
