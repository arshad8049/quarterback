/**
 * QB-02 step 6 — T-AUTH with a fake credential (agent-sandbox.md §5, §11.2).
 * QB_INTEGRATION=1 only. Uses its own auth volume (QB_AUTH_VOLUME is set before
 * the module loads), never the user's login. T-POLICY (real Claude through the
 * proxy) needs a real login and is a separate, manual step.
 */

process.env.QB_AUTH_VOLUME = `qb-test-auth-${process.pid}`;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../../lib/sandbox/docker');
const A = require('../../lib/sandbox/auth');
const { createWorkspace, hardened } = require('../../lib/sandbox/workspace');

const ENABLED = process.env.QB_INTEGRATION === '1';
const BUSYBOX = 'busybox:1.36.1';
const FAKE_ACCESS = 'sk-ant-oat01-FAKEFAKEFAKEaccess000';
let stateDir, ws, seq = 0;
const runs = [];

async function writeFakeCredential(expiresInMs) {
  const json = JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS, refreshToken: 'sk-ant-ort01-FAKErefresh000',
    expiresAt: Date.now() + expiresInMs, scopes: ['user:inference'], subscriptionType: 'pro' } });
  const r = await D.op(['run', '--rm', '-i', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a`, BUSYBOX,
    'sh', '-c', 'cat > /a/.credentials.json && chmod 600 /a/.credentials.json'], { input: json });
  assert.ok(r.ok, r.stderr);
}
const storedHash = async () => (await D.op(['run', '--rm', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a:ro`, BUSYBOX,
  'sha256sum', '/a/.credentials.json'])).stdout.split(' ')[0];
const ok = async () => ({ ok: true });
async function newWs() { const id = `qbauth-${process.pid}-${seq++}`; runs.push(id); return createWorkspace(id); }

describe('T-AUTH (fake credential)', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  before(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-authstate-'));
    await D.op(['volume', 'create', A.AUTH_VOLUME]);
    await D.op(['run', '--rm', '--user', '0', '-v', `${A.AUTH_VOLUME}:/v`, BUSYBOX, 'chown', '10001:10001', '/v']);
    ws = await newWs();
  });
  after(async () => {
    for (const id of runs) await D.removeRun(id);
    await D.op(['volume', 'rm', '-f', A.AUTH_VOLUME]);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('Mode S: only .credentials.json is copied into the run; the agent mounts only that copy', async () => {
    await writeFakeCredential(8 * 3600_000);
    await D.op(['run', '--rm', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a`, BUSYBOX, 'sh', '-c', 'echo x > /a/.claude.json; mkdir -p /a/projects']);
    const c = await A.credentialsForRun(ws, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} });
    assert.equal(c.mode, 'S');
    assert.deepEqual(c.credentialArgs, ['-v', `${ws.runId}-cred:/cfg`]);
    const r = await D.op(['run', '--rm', ...hardened(ws.runId, 'probe'), '--network', 'none', ...c.credentialArgs, BUSYBOX, 'ls', '-A', '/cfg']);
    assert.equal(r.stdout.trim(), '.credentials.json');
  });

  test('no write-back: an agent overwriting its copy with attacker values leaves the stored credential byte-identical', async () => {
    const before0 = await storedHash();
    const w = await newWs();
    const c = await A.credentialsForRun(w, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} });
    const r = await D.op(['run', '--rm', ...hardened(w.runId, 'workload'), '--network', 'none', ...c.credentialArgs, BUSYBOX,
      'sh', '-c', 'echo \'{"claudeAiOauth":{"accessToken":"attacker","refreshToken":"attacker","expiresAt":9999999999999}}\' > /cfg/.credentials.json; echo hook > /cfg/settings.json']);
    assert.ok(r.ok);
    // The write really landed in the run's copy (guards against an empty copy passing this test).
    const seen = await D.op(['run', '--rm', ...hardened(w.runId, 'probe'), '--network', 'none', ...c.credentialArgs, BUSYBOX,
      'grep', '-c', 'attacker', '/cfg/.credentials.json']);
    assert.equal(seen.stdout.trim(), '1');
    await D.removeRun(w.runId);
    assert.equal(await storedHash(), before0);
  });

  test('a token that would expire during the stage → AUTH_REFRESH_REQUIRED, nothing copied', async () => {
    await writeFakeCredential(5 * 60_000);
    const w = await newWs();
    await assert.rejects(A.credentialsForRun(w, stateDir, { stageDeadlineMs: 30 * 60_000, refresh: ok, env: {} }),
      (e) => e.code === 'AUTH_REFRESH_REQUIRED');
    const r = await D.op(['run', '--rm', ...hardened(w.runId, 'probe'), '--network', 'none', '-v', `${w.runId}-cred:/cfg:ro`, BUSYBOX, 'ls', '-A', '/cfg']);
    assert.equal(r.stdout.trim(), '', 'no credential may be copied for a run that is refused');
  });

  test('a failed pre-run refresh → AUTH_REFRESH_FAILED (real official binary, fake token)', async () => {
    await writeFakeCredential(-60_000);
    const w = await newWs();
    await assert.rejects(A.credentialsForRun(w, stateDir, { stageDeadlineMs: 600_000, env: {} }),
      (e) => e.code === 'AUTH_REFRESH_FAILED');
  });

  test('the auth lock: a concurrent login/refresh waits, then reports AUTH_BUSY', async () => {
    let release;
    const held = A.withAuthLock(stateDir, () => new Promise((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(A.withAuthLock(stateDir, async () => 'second', { timeoutMs: 800 }), (e) => e.code === 'AUTH_BUSY');
    release(); await held;
    assert.equal(await A.withAuthLock(stateDir, async () => 'after', { timeoutMs: 800 }), 'after');
  });

  test('Mode K: passed by variable name only; no credential file on the host; value never in argv', async () => {
    const c = await A.credentialsForRun(ws, stateDir, { stageDeadlineMs: 600_000, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' } });
    const { binding, ...rest } = c;
    assert.deepEqual(rest, { mode: 'K', variable: 'ANTHROPIC_API_KEY', credentialArgs: ['-e', 'ANTHROPIC_API_KEY'] });
    assert.ok(require('../../lib/sandbox/credential-check').validBinding(binding, 'K'), 'KAN-44 10837 B3: a salted fingerprint is recorded');
    assert.ok(!JSON.stringify(c).includes('FAKE'));
  });

  test('KAN-44 10814: the run\'s own credential in a patch is found in a trusted container; only a word comes back', async () => {
    const { exactModeS } = require('../../lib/sandbox/credential-check');
    const w = await newWs();
    await writeFakeCredential(3 * 3600_000);
    await A.credentialsForRun(w, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} });
    const o = { image: w.image, runId: w.runId, authVolume: A.AUTH_VOLUME, labels: D.runLabels(w.runId, 'credential-check') };
    assert.equal(await exactModeS(Buffer.from('+const a = 1\n'), o), 'absent');
    assert.equal(await exactModeS(Buffer.from(`+const a = '${FAKE_ACCESS}'\n`), o), 'found');
    assert.equal(await exactModeS(Buffer.from('+sk-ant-ort01-FAKErefresh000\n'), o), 'found', 'the refresh token too');
    assert.equal(await exactModeS(Buffer.concat([Buffer.from([0, 255]), Buffer.from(FAKE_ACCESS)]), o), 'found', 'binary-safe');
    assert.equal(await exactModeS(Buffer.alloc(5 * 1024 * 1024, 'x'), o), 'absent', 'a large patch');
    // an agent that overwrites or breaks its copy cannot hide the stored credential
    for (const body of ['{"claudeAiOauth":{"accessToken":"attacker-value-0000000000"}}', 'not json', '']) {
      const r = await D.op(['run', '--rm', '-i', '--user', '10001:10001', '-v', `${w.runId}-cred:/c`, BUSYBOX, 'sh', '-c', 'cat > /c/.credentials.json'], { input: body });
      assert.ok(r.ok, r.stderr);
      assert.equal(await exactModeS(Buffer.from(FAKE_ACCESS), o), 'found', body);
      assert.equal(await exactModeS(Buffer.from('clean'), o), 'absent', body);
    }
    // no stored credential to compare with: an error, never absent
    const empty = `qb-k44-empty-${process.pid}`;
    await D.op(['volume', 'create', empty]);
    try { assert.equal(await exactModeS(Buffer.from('clean'), { ...o, authVolume: empty, runId: null }), 'error'); }
    finally { await D.op(['volume', 'rm', '-f', empty]); }
  });

  test('KAN-44 10837 B3: the run records salted fingerprints of its (dummy) credential; a recheck clears only against the same one', async () => {
    const CC = require('../../lib/sandbox/credential-check');
    const { recheckExact } = require('../../lib/sandbox/cli');
    const w = await newWs();
    await writeFakeCredential(3 * 3600_000);
    const c = await A.credentialsForRun(w, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} });
    assert.ok(CC.validBinding(c.binding, 'S'), JSON.stringify(c.binding));
    assert.deepEqual(c.binding.fingerprints, [CC.fingerprint(c.binding.salt, FAKE_ACCESS), CC.fingerprint(c.binding.salt, 'sk-ant-ort01-FAKErefresh000')]);
    assert.ok(!JSON.stringify(c).includes('FAKE'));
    const exact = { mode: 'S', status: 'error', binding: c.binding };
    const o = { image: w.image };
    assert.equal((await recheckExact(Buffer.from('+clean\n'), exact, o)).status, 'absent', 'same login: compared');
    assert.equal((await recheckExact(Buffer.from(`+${FAKE_ACCESS}\n`), exact, o)).status, 'found');
    // the login is refreshed or replaced after the run: the run's credential is no longer there to compare with
    const r = await D.op(['run', '--rm', '-i', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a`, BUSYBOX, 'sh', '-c', 'cat > /a/.credentials.json'],
      { input: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-FAKEreplacedaccess00', refreshToken: 'sk-ant-ort01-FAKErefresh000', expiresAt: Date.now() + 3600_000 } }) });
    assert.ok(r.ok, r.stderr);
    assert.equal((await recheckExact(Buffer.from('+clean\n'), exact, o)).status, 'unbound', 'today\'s login is not the run\'s: never absent');
    assert.equal((await recheckExact(Buffer.from(`+${FAKE_ACCESS}\n`), exact, o)).status, 'unbound', 'nothing is compared once unbound');
    await writeFakeCredential(3 * 3600_000);
  });

  test('KAN-44 10837: the scan container is removed after a timeout and after a cancellation (unique labels)', async () => {
    const { exactModeS } = require('../../lib/sandbox/credential-check');
    const w = await newWs();
    await writeFakeCredential(3 * 3600_000);
    const left = async (owner) => (await D.op(['ps', '-aq', '--filter', `label=qb.run=${owner}`])).stdout.trim();
    // A real container that does not answer: the comparison script is swapped for one that reads its input and then
    // hangs (test only), so the deadline and the cancellation really hit a running container.
    const hang = async (args, o) => D.op(args[0] === 'create' ? args.map((x) => (String(x).startsWith('set -eu') ? 'cat > /dev/null; sleep 120' : x)) : args, o);
    const running = async (owner) => (await D.op(['ps', '-q', '--filter', `label=qb.run=${owner}`, '--filter', 'status=running'])).stdout.trim();
    const t = `qb-k44-timeout-${process.pid}`; runs.push(t);
    let seenT = '';
    const probeT = setTimeout(async () => { seenT = await running(t); }, 1500);
    assert.equal(await exactModeS(Buffer.from('x'), { image: w.image, authVolume: A.AUTH_VOLUME, labels: D.runLabels(t, 'credential-check'), op: hang, timeoutMs: 3000 }), 'error');
    clearTimeout(probeT);
    assert.notEqual(seenT, '', 'the container was really running before the deadline');
    assert.equal(await left(t), '', 'no container left after the timeout');
    const ac = new AbortController();
    const cn = `qb-k44-cancel-${process.pid}`; runs.push(cn);
    let seenC = '';
    setTimeout(async () => { seenC = await running(cn); ac.abort(new Error('test cancel')); }, 1500);
    const t0 = Date.now();
    assert.equal(await exactModeS(Buffer.from('x'), { image: w.image, authVolume: A.AUTH_VOLUME, labels: D.runLabels(cn, 'credential-check'), op: hang, signal: ac.signal, timeoutMs: 60_000 }), 'error');
    assert.ok(Date.now() - t0 < 30_000, 'the cancellation ended it, not the 60 s deadline');
    assert.notEqual(seenC, '', 'the container was really running before the cancellation');
    assert.equal(await left(cn), '', 'no container left after the cancellation');
    for (const id of [t, cn]) assert.equal((await D.op(['volume', 'ls', '-q', '--filter', `name=${id}`])).stdout.trim(), '', 'and no volume was created');
  });

  test('not logged in → AUTH_NOT_LOGGED_IN', async () => {
    await D.op(['volume', 'rm', '-f', A.AUTH_VOLUME]);
    await assert.rejects(A.credentialsForRun(ws, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} }),
      (e) => e.code === 'AUTH_NOT_LOGGED_IN');
  });
});
