// KAN-114 10720 (U2): the research-only Karma channel. QB's own config wrapper and reporter (read-only, outside the
// workspace) run the repo's karma config with a QB launcher that keeps the Chromium sandbox ON, and a validator that
// only trusts a complete, current, consistent report. Synthetic fixtures only: no karma, no browser, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const K = require('../../lib/research/karma-channel');
const V = require('../../lib/research/karma-report');
const REPORTER = path.join(ROOT, 'sandbox/research/qb-karma-reporter.cjs');
const WRAPPER = path.join(ROOT, 'sandbox/research/qb-karma.conf.cjs');
const REPO_CONF = path.join(__dirname, '..', 'fixtures', 'kan114-u2', 'repo-karma.conf.js');

const envRec = (o = {}) => ({
  schema: 'qb-kan114-task-env/3', task: 'fixture-1', runner: 'karma', karma_version: '6.4.4', karma_chrome_launcher_version: '3.2.0',
  repo_config: 'karma.conf.js', files_grep: null, env: { COVERAGE: 'false', BABEL_NO_MODULES: 'true' }, timeout_s: 900,
  browser: { launcher: 'QBChromeHeadless', sandbox: 'on' }, ...o,
});

// ── a fake karma run through QB's real reporter ──
function fakeRun({ nonce = 'n-1', tests = [['suite a', 'adds', 'passed'], ['suite a', 'removes', 'passed'], ['suite b', 'renders', 'failed']],
  browserError = false, disconnected = false, karmaVersion = '6.4.4', browserName = 'HeadlessChrome 130.0.0.0 (Linux x86_64)', endStats = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbkarma-'));
  const out = path.join(dir, 'report.jsonl');
  const Rep = require(REPORTER)['reporter:qb'][1];
  const rep = new Rep(() => {}, { qbReporter: { outPath: out, nonce, karmaVersion } });
  const browser = { id: 'b1', name: browserName };
  rep.onRunStart([browser]);
  rep.onBrowserStart(browser);
  let ok = 0; let bad = 0; let skip = 0;
  for (const [suite, description, state] of tests) {
    const r = { suite: [suite], description, success: state === 'passed', skipped: state === 'skipped', pending: false, log: state === 'failed' ? ['AssertionError: x'] : [] };
    if (state === 'passed') { ok += 1; rep.specSuccess(browser, r); } else if (state === 'failed') { bad += 1; rep.specFailure(browser, r); } else { skip += 1; rep.specSkipped(browser, r); }
  }
  if (browserError) rep.onBrowserError(browser, new Error('script error'));
  rep.onBrowserComplete(browser, { success: ok, failed: bad, skipped: skip, error: browserError, disconnected });
  rep.onRunComplete([browser], endStats || { success: ok, failed: bad, error: browserError, disconnected, exitCode: bad || browserError || disconnected ? 1 : 0 });
  return { text: fs.readFileSync(out, 'utf8'), exitCode: bad || browserError || disconnected ? 1 : 0, out };
}
const validate = (r, o = {}) => V.validateKarmaRun({ reportText: r.text, exitCode: r.exitCode, startedAtMs: Date.now() - 1000, nonce: 'n-1', karmaVersion: '6.4.4', ...o });

test('a real reporter report with a failing test validates as failed; identities are hashes, never names', () => {
  const r = fakeRun();
  const v = validate(r);
  assert.equal(v.verdict, 'failed', v.reasons.join(','));
  assert.deepEqual(v.counts, { total: 3, passed: 2, failed: 1, skipped: 0 });
  for (const e of v.identities) assert.match(e.id, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(v.identities).includes('renders'));
  const p = fakeRun({ tests: [['s', 'a', 'passed'], ['s', 'b', 'skipped']] });
  assert.equal(validate(p).verdict, 'passed');
});

test('error, never pass: zero tests, missing / truncated / appended / stale / foreign reports, browser errors, disconnects, count or exit drift', () => {
  const cases = [
    [{ ...fakeRun({ tests: [] }) }, {}, 'zero_tests'],
    [{ text: null, exitCode: 0 }, {}, 'no_report'],
    [(() => { const r = fakeRun(); return { ...r, text: r.text.split('\n').slice(0, -2).join('\n') + '\n' }; })(), {}, 'incomplete_report'],
    [(() => { const r = fakeRun(); return { ...r, text: r.text.slice(0, -5) }; })(), {}, 'incomplete_report'],
    [(() => { const r = fakeRun({ tests: [['s', 'a', 'passed']] }); return { ...r, text: r.text + r.text }; })(), {}, 'malformed_report'],
    [fakeRun({ tests: [['s', 'a', 'passed']] }), { nonce: 'other' }, 'nonce_mismatch'],
    [fakeRun({ tests: [['s', 'a', 'passed']] }), { startedAtMs: Date.now() + 60_000 }, 'stale_report'],
    [fakeRun({ tests: [['s', 'a', 'passed']], karmaVersion: '6.3.0' }), {}, 'karma_version_mismatch'],
    [fakeRun({ tests: [['s', 'a', 'passed']], browserError: true }), {}, 'browser_error'],
    [fakeRun({ tests: [['s', 'a', 'passed']], disconnected: true }), {}, 'browser_disconnected'],
    [fakeRun({ tests: [['s', 'a', 'passed']], browserName: 'Firefox 120' }), {}, 'wrong_browser'],
    [fakeRun({ tests: [['s', 'a', 'passed']], endStats: { success: 5, failed: 0, error: false, disconnected: false, exitCode: 0 } }), {}, 'inconsistent_counts'],
    [{ ...fakeRun({ tests: [['s', 'a', 'passed']] }), exitCode: 1 }, {}, 'exit_contradicts_report'],
    [{ ...fakeRun({ tests: [['s', 'a', 'failed']] }), exitCode: 0 }, {}, 'exit_contradicts_report'],
    [{ text: 'not json\n', exitCode: 0 }, {}, 'malformed_report'],
  ];
  for (const [r, o, reason] of cases) {
    const v = validate(r, o);
    assert.equal(v.verdict, 'error', `${reason}: got ${v.verdict}`);
    assert.ok(v.reasons.includes(reason), `${reason}: got ${v.reasons.join(',')}`);
  }
});

test('the reporter refuses to append to a pre-existing report file (a planted report cannot be extended)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbkarma-'));
  const out = path.join(dir, 'report.jsonl');
  fs.writeFileSync(out, '{"type":"qb:start"}\n');
  const Rep = require(REPORTER)['reporter:qb'][1];
  const rep = new Rep(() => {}, { qbReporter: { outPath: out, nonce: 'n', karmaVersion: '6.4.4' } });
  assert.throws(() => rep.onRunStart([]), /EEXIST|exists/);
});

test('baseline: a candidate run must execute exactly the base identity multiset', () => {
  const base = V.baselineFrom(validate(fakeRun()));
  assert.equal(validate(fakeRun(), { baseline: base }).reasons.length, 0);
  const fewer = validate(fakeRun({ tests: [['suite a', 'adds', 'passed'], ['suite b', 'renders', 'failed']] }), { baseline: base });
  assert.ok(fewer.reasons.includes('missing_executions'));
  const more = validate(fakeRun({ tests: [['suite a', 'adds', 'passed'], ['suite a', 'removes', 'passed'], ['suite b', 'renders', 'failed'], ['x', 'y', 'passed']] }), { baseline: base });
  assert.ok(more.reasons.includes('unexpected_tests'));
  const drift = validate(fakeRun({ tests: [['suite a', 'adds', 'skipped'], ['suite a', 'removes', 'passed'], ['suite b', 'renders', 'failed']] }), { baseline: base });
  assert.ok(drift.reasons.includes('status_drift'));
  assert.throws(() => V.baselineFrom({ verdict: 'error' }), /baseline/);
});

test('QB config wrapper: the repo config runs, then QB forces its sandboxed launcher, its reporter, single run, no sauce, no coverage', () => {
  const env = { ...process.env };
  try {
    process.env.QB_KARMA_REPO_CONF = REPO_CONF;
    process.env.QB_KARMA_OUT = '/qbout/r.jsonl'; process.env.QB_KARMA_NONCE = 'n-9'; process.env.QB_KARMA_VERSION = '6.4.4';
    process.env.QB_KARMA_FLAGS = JSON.stringify(K.BASE_FLAGS);
    process.env.RUN_SAUCE_LABS = 'true'; process.env.COVERAGE = 'true';
    delete require.cache[WRAPPER];
    const cfg = { set(o) { Object.assign(this, o); } };
    require(WRAPPER)(cfg);
    assert.deepEqual(cfg.browsers, ['QBChromeHeadless']);
    assert.deepEqual(Object.keys(cfg.customLaunchers), ['QBChromeHeadless']);
    assert.equal(cfg.customLaunchers.QBChromeHeadless.base, 'ChromeHeadless');
    assert.deepEqual(cfg.customLaunchers.QBChromeHeadless.flags, K.BASE_FLAGS);
    assert.ok(!JSON.stringify(cfg.customLaunchers).includes('--no-sandbox'));
    assert.deepEqual(cfg.reporters, ['qb']);
    assert.equal(cfg.singleRun, true); assert.equal(cfg.autoWatch, false);
    assert.equal(cfg.sauceLabs, undefined);
    assert.deepEqual(cfg.qbReporter, { outPath: '/qbout/r.jsonl', nonce: 'n-9', karmaVersion: '6.4.4' });
    assert.ok(cfg.plugins.includes('karma-*'));
    assert.ok(cfg.plugins.some((p) => p && typeof p === 'object' && p['reporter:qb']));
    assert.equal(cfg.listenAddress, '127.0.0.1'); assert.equal(cfg.hostname, '127.0.0.1');
    // the wrapper itself refuses any flag outside its own fixed set (defence in depth for a host-side bug)
    for (const bad of [['--no-sandbox'], ['--disable-setuid-sandbox'], ['--disable-web-security'], ['--proxy-server=x'], [...K.BASE_FLAGS, '--single-process']]) {
      process.env.QB_KARMA_FLAGS = JSON.stringify(bad);
      delete require.cache[WRAPPER];
      assert.throws(() => require(WRAPPER)({ set() {} }), /qb-karma: flag/);
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env); delete require.cache[WRAPPER];
  }
});

test('launcher policy: sandbox ON by default; the no-sandbox exception is refused unless separately approved', () => {
  assert.deepEqual(K.launcherFlags({}), K.BASE_FLAGS);
  assert.ok(!K.BASE_FLAGS.some((f) => /sandbox/.test(f)));
  assert.throws(() => K.launcherFlags({ exception: K.EXCEPTION_ID }), /not approved/);
  assert.throws(() => K.launcherFlags({ exception: K.EXCEPTION_ID, approvals: { browser_sandbox_exception: { approval_comment_id: null } } }), /not approved/);
  assert.throws(() => K.launcherFlags({ exception: 'other' , approvals: { browser_sandbox_exception: { approval_comment_id: '1' } } }), /unknown/);
  const f = K.launcherFlags({ exception: K.EXCEPTION_ID, approvals: { browser_sandbox_exception: { id: K.EXCEPTION_ID, approval_comment_id: '12345' } } });
  assert.deepEqual(f, [...K.BASE_FLAGS, '--no-sandbox']);
  assert.deepEqual(K.launcherProblems(K.BASE_FLAGS, {}), []);
  assert.ok(K.launcherProblems(['--no-sandbox'], {}).length > 0);
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/u2/approvals.json'), 'utf8'));
  assert.equal(committed.browser_sandbox_exception.approval_comment_id, null, 'the exception is NOT approved in the committed approvals');
  assert.throws(() => K.launcherFlags({ exception: K.EXCEPTION_ID, approvals: committed }), /not approved/);
});

test('env record /3 validation and the exact invocation (no repo-controlled reporter, config, env or browser)', () => {
  assert.doesNotThrow(() => K.validateKarmaEnv(envRec()));
  for (const bad of [
    { schema: 'qb-kan117-task-env/2' }, { runner: 'mocha' }, { karma_version: '^6.4.0' }, { karma_version: 'latest' },
    { env: { COVERAGE: 'false', CI: 'true' } }, { env: { RUN_SAUCE_LABS: 'true' } }, { env: { SAUCE_USERNAME: 'x' } }, { env: { COVERAGE: 'maybe' } },
    { env: { NODE_OPTIONS: '--require x' } }, { repo_config: '../karma.conf.js' }, { repo_config: '/etc/karma.conf.js' },
    { files_grep: '../../**/*.js' }, { timeout_s: 99999 }, { browser: { launcher: 'ChromeNoSandboxHeadless', sandbox: 'on' } },
    { browser: { launcher: 'QBChromeHeadless', sandbox: 'off' } },
  ]) assert.throws(() => K.validateKarmaEnv(envRec(bad)), /karma env/, JSON.stringify(bad));
  const inv = K.karmaInvocation(envRec(), { nonce: 'n-1', outPath: '/qbout/x.jsonl', researchDir: '/qb/research', repoRoot: '/work' });
  assert.deepEqual(inv.argv, ['node', 'node_modules/karma/bin/karma', 'start', '/qb/research/qb-karma.conf.cjs', '--single-run', '--no-auto-watch']);
  assert.equal(inv.env.QB_KARMA_REPO_CONF, '/work/karma.conf.js');
  assert.equal(inv.env.QB_KARMA_NONCE, 'n-1');
  assert.equal(inv.env.CHROME_BIN, '/usr/bin/chromium');
  assert.deepEqual(JSON.parse(inv.env.QB_KARMA_FLAGS), K.BASE_FLAGS);
  assert.ok(!('CI' in inv.env) && !('RUN_SAUCE_LABS' in inv.env));
  const g = K.karmaInvocation(envRec({ files_grep: 'hooks/test/browser/**/*.test.js' }), { nonce: 'n', outPath: '/qbout/x', researchDir: '/qb/research', repoRoot: '/work' });
  assert.equal(g.argv.at(-1), '--grep=hooks/test/browser/**/*.test.js');
});

test('the host-side flag list and the wrapper flag list are the same constants', () => {
  const w = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(w, new RegExp(`const BASE_FLAGS = ${JSON.stringify(K.BASE_FLAGS).replace(/[[\]]/g, '\\$&')};`));
  assert.match(w, new RegExp(`const EXCEPTION_ID = '${K.EXCEPTION_ID}';`));
});
