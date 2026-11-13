/**
 * KAN-113 review 10594/10596 (fixtures only): fail closed when host memory is unverified; a no-credential
 * pipeline mode for the fake-CLI qualification run; the host-gate order (stop at the first blocker); the fake CLI.
 * No Docker, no model, no credentials.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const A = require('../../lib/sandbox/admission');
const P = require('../../lib/sandbox/agent-profile');
const { runAgentSandboxed } = require('../../agent/runner');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'opus-pilot', 'pilot-config.json'), 'utf8'));
const profile = () => ({ ...P.profileFromConfig(CFG), auth_route: 'test-only-route' });

describe('KAN-113 10594: pilot runs fail closed when host memory is unverified', () => {
  test('memoryGate: unchecked memory is refused when required; checked or not-required passes', () => {
    assert.match(A.memoryGate({ ok: true, memory_checked: false }, { require: true }), /memory_unverified/);
    assert.equal(A.memoryGate({ ok: true, memory_checked: true }, { require: true }), null);
    assert.equal(A.memoryGate({ ok: true, memory_checked: false }, { require: false }), null);
  });
  test('admit() on a host without /proc/meminfo reports memory_checked false (the macOS gap)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113adm-'));
    const r = A.admit(d, { runId: 'kan113-test', meminfo: '' });
    assert.equal(r.memory_checked, false); if (r.release) r.release(); fs.rmSync(d, { recursive: true, force: true });
  });
  test('a pilot run asks the sandbox to require a memory check; a non-pilot run does not', async () => {
    const calls = []; const fake = async (o) => { calls.push(o); return { status: 'blocked', reason: 'stop', sandbox: null }; };
    await runAgentSandboxed('t', '/r', { agentProfile: profile(), approvedAuthRoutes: ['test-only-route'], runSandboxed: fake });
    await runAgentSandboxed('t', '/r', { runSandboxed: fake });
    assert.equal(calls[0].requireMemoryCheck, true); assert.equal(calls[1].requireMemoryCheck, undefined);
  });
  test('the pipeline applies the memory gate after admission and supports an explicit no-credential mode', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'sandbox', 'pipeline.js'), 'utf8');
    assert.match(src, /memoryGate\(adm, \{ require: o\.requireMemoryCheck === true \}\)/);
    assert.match(src, /o\.noCredentials === true/);
    assert.match(src, /credential_mode = 'none'/);
  });
});

describe('KAN-113 10596: host-gate evaluation stops at the first blocker', () => {
  const G = () => import(path.join(ROOT, 'bench', 'opus-pilot', 'host', 'gates.mjs'));
  const good = () => ({
    host: { arch: 'x86_64', kernel: '6.8.0', docker: '28.0.0', mem_available_bytes: 15e9, disk_free_bytes_after: 20e9 },
    images: { tools: 'sha256:' + 'a'.repeat(64), agent: 'sha256:' + 'b'.repeat(64), proxy: 'sha256:' + 'c'.repeat(64), fake_cli: 'sha256:' + 'd'.repeat(64) },
    admission: { ok: true, memory_checked: true },
    pipeline: { status: 'completed', credential_mode: 'none', classification: 'verified', fake_change_captured: true, leftovers_removed: true },
    cleanup: { normal: true, refusal: true, timeout: true, cancellation: true, crash: true },
    isolation: { bash_normal_mode_blocks_dummy: true, file_tools_enforced: true },
  });
  test('all gates pass on a complete good report', async () => { const { evaluateHost } = await G(); const r = evaluateHost(good()); assert.equal(r.passed, true, JSON.stringify(r)); assert.equal(r.first_blocker, null); });
  for (const [why, mutate, gate] of [
    ['a non-x86 host', (x) => { x.host.arch = 'aarch64'; }, 'host'],
    ['too little free disk after setup', (x) => { x.host.disk_free_bytes_after = 1e9; }, 'disk'],
    ['admission refused', (x) => { x.admission = { ok: false, reason: 'insufficient_host_resources' }; }, 'admission'],
    ['memory not actually checked', (x) => { x.admission = { ok: true, memory_checked: false }; }, 'admission'],
    ['a missing image digest', (x) => { delete x.images.proxy; }, 'images'],
    ['the fake-CLI pipeline not completing', (x) => { x.pipeline.status = 'infra_error'; }, 'pipeline'],
    ['a pipeline that used credentials', (x) => { x.pipeline.credential_mode = 'S'; }, 'pipeline'],
    ['leftover resources after cancellation', (x) => { x.cleanup.cancellation = false; }, 'cleanup'],
    ['Bash isolation failing in normal sandbox mode', (x) => { x.isolation.bash_normal_mode_blocks_dummy = false; }, 'isolation'],
    ['file tools not enforced', (x) => { x.isolation.file_tools_enforced = false; }, 'isolation'],
  ]) {
    test(`blocked at the ${gate} gate on ${why}`, async () => { const { evaluateHost } = await G(); const x = good(); mutate(x); const r = evaluateHost(x); assert.equal(r.passed, false); assert.equal(r.first_blocker.gate, gate); });
  }
  test('an earlier failure is reported first even when later gates also fail (no gate is skipped silently)', async () => {
    const { evaluateHost } = await G(); const x = good(); x.admission = { ok: false }; x.isolation.file_tools_enforced = false;
    const r = evaluateHost(x); assert.equal(r.first_blocker.gate, 'admission'); assert.ok(r.gates.some((g) => g.gate === 'isolation' && g.status === 'not_reached'));
  });
});

describe('KAN-113 10596: the fake CLI used for the no-model pipeline', () => {
  const FAKE = path.join(ROOT, 'bench', 'opus-pilot', 'host', 'fake-cli', 'fake-claude.sh');
  test('it never needs a credential or network, edits the work tree, and emits a complete, clearly-marked synthetic stream', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113fake-'));
    const r = spawnSync('sh', [FAKE, '-p', ...P.buildAgentArgs(profile())], { cwd: d, input: 'qualification task\n', encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(d, 'QB_FAKE_AGENT_CHANGE.txt')));
    const c = P.classifyAttempt({ stdout: r.stdout }, profile());
    assert.equal(c.outcome, 'verified', c.reasons.join('; '));
    assert.match(r.stdout, /"qb_fake_cli":true/);
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('--version reports the frozen CLI version; FAKE_SLEEP in the prompt delays it (for the timeout/cancel/crash cases)', () => {
    assert.equal(spawnSync('sh', [FAKE, '--version'], { encoding: 'utf8' }).stdout.trim(), '2.1.322 (Claude Code)');
    const t0 = Date.now(); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113fake-'));
    spawnSync('sh', [FAKE, '-p', '--model', 'claude-opus-5-5'], { cwd: d, input: 'FAKE_SLEEP=1\n', encoding: 'utf8' });
    assert.ok(Date.now() - t0 >= 900); fs.rmSync(d, { recursive: true, force: true });
  });
});
