// KAN-117 (senior direction after 10624): research-only adapter from the visible Mocha channel to QB's REAL verdict and
// repair logic, with a frozen, approved, exact-match exception list. Visible results stay advisory/untrusted; ordinary
// customer runs are unchanged. Everything is fake (no Docker, no model): real reporter → real validator → real verify().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { execute } = require('../../agent/runner');
const { verify } = require('../../verify/verifier');
const { classifyTestRun } = require('../../verify/tests');
const M = require('../../verify/mocha-report');
const E = require('../../lib/research/dataset-env');

const ROOT = path.join(__dirname, '..', '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const REPORTER = require(path.join(ROOT, 'sandbox/research/qb-mocha-reporter.cjs'));
const F = '/verify/test/unit/a.js'; const REL = 'test/unit/a.js';
const idOf = (title) => sha(`${REL}\0${title}`);

/** Drive the REAL reporter with a fake Mocha runner; tests: [title, state, {kind-producing error}] */
function report(tests, { nonce = 'n', version = '10.0.0' } = {}) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbad-')), 'r.ndjson');
  const r = new EventEmitter(); r.stats = { suites: 0, tests: 0, passes: 0, pending: 0, failures: 0 };
  new REPORTER(r, { reporterOptions: { output: out, nonce, mocha_version: version } }); // eslint-disable-line no-new
  r.emit('start'); r.emit('suite', { file: F });
  for (const [title, state, err] of tests) {
    const t = { file: F, type: 'test', title, fullTitle: () => title };
    if (state === 'passed') { r.emit('pass', t); r.stats.passes++; } else if (state === 'pending') { r.emit('pending', t); r.stats.pending++; } else { r.emit('fail', t, err); r.stats.failures++; }
    r.stats.tests++;
  }
  r.emit('end');
  return fs.readFileSync(out, 'utf8');
}
const net = () => Object.assign(new Error('getaddrinfo EAI_AGAIN example.invalid'), { code: 'EAI_AGAIN' });
const ip = () => Object.assign(new TypeError('Invalid IP address: undefined'), { code: 'ERR_INVALID_IP_ADDRESS' });
const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
const assertion = () => { const e = new Error('expected true to equal false'); e.name = 'AssertionError'; e.code = 'ERR_ASSERTION'; return e; };

const BASE = [['dns test', 'failed', net()], ['ip test', 'failed', ip()], ['ok 1', 'passed'], ['ok 2', 'passed'], ['skipped', 'pending']];
const validate = (text, baseline, exitCode) => M.validateMochaRun({ reportText: text, exitCode, startedAtMs: 0, nonce: 'n', root: '/verify', files: [REL], mochaVersion: '10.0.0', baseline });
const baseV = validate(report(BASE), null, 2);
const baseline = M.baselineFrom(baseV);
const exceptionFor = (title) => { const e = baseV.identities.find((x) => x.id === idOf(title)); return { id: e.id, file: e.file, kinds: e.kinds, codes: e.codes, count: e.count, justification: `fixture: ${title} cannot pass without network` }; };
const PROBE = { node: 'v24.22.3', ci: null, mocha: '10.0.0' };
const BASE_COMMIT = 'a'.repeat(40);
/** review 10631: an approval is BOUND to base, runtime and the exact exception-set hash; a bare string is not binding */
const EXC = (approved = 'reviewer (fixture)', o = {}) => {
  const x = { schema: 'qb-known-base-failures/1', entries: [exceptionFor('dns test'), exceptionFor('ip test')], isolation_rechecks: o.rechecks || [] };
  x.approval = approved ? { by: approved, ref: 'fixture', base_commit: BASE_COMMIT, node: PROBE.node, mocha: PROBE.mocha, set_sha256: E.knownSetSha256(x), ...(o.approval || {}) } : null;
  return x;
};

/** The research verification object exactly as lib/sandbox/pipeline.js records it (mode research_mocha). */
function researchV(tests, { exc = EXC(), verdictOverride, exitCode } = {}) {
  const text = report(tests);
  const failures = tests.filter((t) => t[1] === 'failed').length;
  const v = validate(text, baseline, exitCode ?? (failures ? failures : 0));
  return { mode: 'research_mocha', test_plan: { status: 'run', runner: 'mocha', source: 'research_env', task_id: 'qbt_000000000001' },
    status: 'ran', verdict: verdictOverride || v.verdict, reasons: v.reasons, validation: v, known_base_failures: exc, probe: PROBE, task_base_commit: BASE_COMMIT,
    steps: [{ name: 'test', state: failures ? 'execution_error' : 'completed', exit_code: exitCode ?? failures, duration_ms: 10 }] };
}

const CHANGE = { file: 'src/a.js', status: 'M', additions: 1, deletions: 1, binary: false };
const DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
const contract = (policy) => approve({ id: 'c', goal: 'Set a to 2', acceptance_criteria: [{ id: 'AC-1', criterion: 'a is 2', met: null, kind: 'non_behavioral' }],
  clarifying_question: null, scope: { allowed_changes: ['src/**'] }, ...(policy ? { test_policy: { preexisting_failures: policy } } : {}) }, { via: 'test' });
async function verdictFor(v, policy = 'waive') {
  const c = contract(policy);
  const exec = await execute('task', c, null, { agent: 'claude-code', repoPath: '/repo',
    runSandboxed: async () => ({ status: 'completed', diff: DIFF, changes: [CHANGE], sandbox: { verification: v } }) });
  const f = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
  try { return await verify(c, null, exec, { repoPath: '/repo' }); } finally { f.restore(); }
}
const hintsFor = (report, title) => report.repair_hints.filter((h) => h.diagnosis.includes(title) || h.criterion_id.includes(title));

// ── exception list: frozen, approved, exact ──
test('exception entries must be exact (identity, file, kinds, codes, count) and justified; a broad label alone is refused', () => {
  const ok = EXC();
  assert.doesNotThrow(() => E.validateKnownBaseFailures(ok));
  for (const [why, bad] of [
    ['label only', { ...ok, entries: [{ kinds: ['TypeError'], justification: 'x' }] }],
    ['no id', { ...ok, entries: [{ ...ok.entries[0], id: undefined }] }],
    ['no codes', { ...ok, entries: [{ ...ok.entries[0], codes: undefined }] }],
    ['no justification', { ...ok, entries: [{ ...ok.entries[0], justification: '' }] }],
    ['duplicate', { ...ok, entries: [ok.entries[0], ok.entries[0]] }],
    ['bare approver string', { ...ok, approval: undefined, approved_by: 'someone' }],
    ['approval without binding', { ...ok, approval: { by: 'x' } }],
  ]) assert.throws(() => E.validateKnownBaseFailures(bad), /known base failures/, why);
});

// ── the real verdict and repair logic ──
test('exact, approved exceptions + contract waive: only the frozen failures, unchanged → preexisting_failures; PASS is ADVISORY, never trusted; no repair hints for them', async () => {
  const r = await verdictFor(researchV(BASE));
  assert.equal(r.test_outcome.outcome, 'preexisting_failures', r.test_outcome.reason);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.test_outcome.trust, 'advisory');
  assert.match(r.test_outcome.trust_note, /unauthenticated/);
  assert.equal(hintsFor(r, 'dns test').length + hintsFor(r, 'ip test').length, 0);
});

test('unapproved exceptions, or the default block policy: the same failures FAIL the task (an exception never applies by itself)', async () => {
  assert.equal((await verdictFor(researchV(BASE, { exc: EXC(null) }))).verdict, 'fail');
  assert.equal((await verdictFor(researchV(BASE), 'block')).verdict, 'fail');
  assert.equal((await verdictFor(researchV(BASE), null)).verdict, 'fail');
});

test('a NEW failure is a regression: FAIL, with a repair hint for it and none for the excepted tests', async () => {
  const r = await verdictFor(researchV([...BASE.slice(0, 2), ['ok 1', 'failed', assertion()], ['ok 2', 'passed'], ['skipped', 'pending']]));
  assert.equal(r.verdict, 'fail');
  assert.equal(r.test_outcome.outcome, 'failed');
  assert.equal(hintsFor(r, 'ok 1').length, 1);
  assert.equal(hintsFor(r, 'dns test').length, 0);
});

test('a CHANGED failure of an excepted test (same test, different code or kind) is a regression, not hidden by the exception', async () => {
  for (const changed of [['dns test', 'failed', refused()], ['dns test', 'failed', assertion()]]) {
    const r = await verdictFor(researchV([changed, ...BASE.slice(1)]));
    assert.equal(r.verdict, 'fail', JSON.stringify(changed[2].code));
    const reg = r.test_outcome.regressions.find((x) => x.name === 'dns test');
    assert.ok(reg && reg.changed_failure === true);
    assert.equal(hintsFor(r, 'dns test').length, 1);
  }
});

test('missing tests and timeouts never pass behind an exception (unresolved, no hints)', async () => {
  const missing = await verdictFor(researchV(BASE.filter((t) => t[0] !== 'ok 2')));
  assert.equal(missing.test_outcome.outcome, 'error'); assert.match(missing.test_outcome.reason, /missing_executions/);
  assert.notEqual(missing.verdict, 'pass');
  const timedOut = await verdictFor({ ...researchV(BASE), verdict: 'stage_timeout', reasons: [] });
  assert.equal(timedOut.test_outcome.outcome, 'error'); assert.equal(timedOut.test_outcome.reason, 'timeout');
  assert.notEqual(timedOut.verdict, 'pass');
  const notRun = await verdictFor({ mode: 'research_mocha', status: 'not_run', reason: 'capture_policy_refused' });
  assert.notEqual(notRun.verdict, 'pass');
});

test('an excepted test that now PASSES is fine; an extra pass never turns into trusted evidence', async () => {
  const r = await verdictFor(researchV([['dns test', 'passed'], ...BASE.slice(1)]));
  assert.equal(r.test_outcome.outcome, 'preexisting_failures');
  assert.equal(r.test_outcome.trust, 'advisory');
});

test('the complete-rewrite forgery (a self-consistent passing report) can reach PASS but is labelled advisory, never trusted/verified', async () => {
  const forged = [{ type: 'qb:start', format: M.FORMAT, nonce: 'n', mocha_version: '10.0.0', started_at: Date.now() }, { type: 'suite', file: F },
    ...BASE.map(([t]) => ({ type: 'test', file: F, full_title: t, title: t, state: t === 'skipped' ? 'pending' : 'passed' })),
    { type: 'qb:end', stats: { suites: 1, tests: 5, passes: 4, pending: 1, failures: 0 } }].map((l) => JSON.stringify(l)).join('\n') + '\n';
  const v = validate(forged, null, 0);
  const r = await verdictFor({ mode: 'research_mocha', status: 'ran', verdict: v.verdict, reasons: v.reasons, validation: v, known_base_failures: EXC(), probe: PROBE, task_base_commit: BASE_COMMIT, steps: [] });
  assert.equal(r.test_outcome.outcome, 'passed');
  assert.equal(r.test_outcome.trust, 'advisory');
  assert.notEqual(r.test_outcome.trust, 'trusted');
  assert.ok(!JSON.stringify(r.test_outcome).includes('"trust":"trusted"'));
});

test('ordinary customer runs (no research mode) are classified exactly as before: no trust label, node:test only', () => {
  const REPORT = fs.readFileSync(path.join(ROOT, 'test/fixtures/node-test-reports/pass.ndjson'), 'utf8');
  const c = classifyTestRun({ status: 'ran', state: 'completed', exit_code: 0, report: REPORT });
  assert.equal(c.outcome, 'passed'); assert.equal(c.runner, 'node-test');
  assert.equal(c.trust, undefined);
});

// ── review 10631: binding ──
test('an approval excuses nothing unless base, runtime and the exception-set hash all match (entries cannot silently expand)', async () => {
  assert.equal((await verdictFor(researchV(BASE))).verdict, 'pass', 'bound and matching');
  for (const [why, exc] of [
    ['other base', EXC('r', { approval: { base_commit: 'b'.repeat(40) } })],
    ['other node', EXC('r', { approval: { node: 'v22.0.0' } })],
    ['other mocha', EXC('r', { approval: { mocha: '10.1.0' } })],
    ['expanded after approval', (() => { const x = EXC(); x.entries.push({ ...x.entries[0], id: 'c'.repeat(64) }); return x; })()],
  ]) {
    const r = await verdictFor(researchV(BASE, { exc }));
    assert.equal(r.verdict, 'fail', why);
    assert.match(r.test_outcome.reason, /tests_failed/);
  }
});

test('approved exceptions are listed with their coverage limits in the report (failures and limitations stay visible)', async () => {
  const r = await verdictFor(researchV(BASE));
  assert.equal(r.test_outcome.preexisting.length, 2);
  assert.ok(r.test_outcome.coverage_limits.some((l) => /cannot pass without network/.test(l)));
});

// ── review 10631 option (c): isolated re-check ──
const H6 = 'max content';
const BASE6 = [...BASE, [H6, 'failed', assertion()]];
const baseV6 = validate(report(BASE6), null, 3);
const recheckFor = () => { const e = baseV6.identities.find((x) => x.id === idOf(H6)); return { id: e.id, file: e.file, full_title: H6, signature: { kinds: e.kinds, codes: e.codes, count: e.count }, justification: 'fixture: passes alone, fails in suite' }; };
function v6(tests, recheck, { exc } = {}) {
  const x = exc || EXC('r', { rechecks: [recheckFor()] });
  const text = report(tests); const nf = tests.filter((t) => t[1] === 'failed').length;
  const v = validate(text, M.baselineFrom(baseV6), nf);
  return { mode: 'research_mocha', test_plan: { runner: 'mocha' }, status: 'ran', verdict: v.verdict, reasons: v.reasons, validation: v, known_base_failures: x,
    probe: PROBE, task_base_commit: BASE_COMMIT, steps: [{ name: 'test', exit_code: nf }], ...(recheck === undefined ? {} : { isolation_rechecks: recheck ? [{ id: idOf(H6), ...recheck }] : [] }) };
}
test('(c) the held test, failing with its exact full-suite signature, is isolation-qualified ONLY when its single isolated re-check qualified', async () => {
  const r = await verdictFor(v6(BASE6, { verdict: 'qualified', reasons: [], executed: 1, tree_match: true }));
  assert.equal(r.test_outcome.outcome, 'preexisting_failures');
  assert.match(r.test_outcome.reason, /isolation_qualified/);
  assert.equal(r.test_outcome.isolation_qualified.length, 1);
  assert.equal(r.test_outcome.isolation_qualified[0].name, H6);
  assert.ok(r.test_outcome.coverage_limits.some((l) => /order safety/.test(l)), 'isolated success does not establish full-suite order safety');
  assert.equal(r.test_outcome.trust, 'advisory');
  assert.equal(hintsFor(r, H6).length, 0);
});
test('(c) a blocked, missing or wrong re-check, or a different full-suite signature, keeps the held test BLOCKING', async () => {
  for (const [why, v] of [
    ['re-check failed', v6(BASE6, { verdict: 'blocked', reasons: ['failed'], executed: 1, tree_match: true })],
    ['re-check missing', v6(BASE6, undefined)],
    ['re-check empty', v6(BASE6, null)],
    ['different signature', v6([...BASE, [H6, 'failed', refused()]], { verdict: 'qualified', reasons: [], executed: 1, tree_match: true })],
    ['re-check not approved', v6(BASE6, { verdict: 'qualified', reasons: [], executed: 1, tree_match: true }, { exc: (() => { const x = EXC('r', { rechecks: [recheckFor()] }); x.approval = null; return x; })() })],
  ]) {
    const r = await verdictFor(v);
    assert.equal(r.verdict, 'fail', why);
    assert.equal(hintsFor(r, H6).length, 1, `${why}: a repair hint for the blocking test`);
  }
});
