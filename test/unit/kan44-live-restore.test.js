/** KAN-44 (senior 10814): Docker live-restore is read, never changed. Enabled or unknown is said explicitly. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { doctor } = require('../../lib/doctor');
const LR = () => require('../../lib/sandbox/live-restore');

const GiB = 1024 ** 3;
const deps = (liveRestore, over = {}) => ({ nodeVersion: 'v24.1.0', gitVersion: async () => 'git 2', dockerVersion: async () => '28', authVolumeExists: async () => true,
  modelTags: async () => ['deepseek-r1:7b'], memAvailable: async () => 14 * GiB, liveRestore: async () => liveRestore, ...over });
const get = (r) => r.checks.find((c) => c.id === 'live-restore');

describe('probe', () => {
  for (const [label, res, want] of [['off', { ok: true, stdout: 'false\n' }, 'disabled'], ['on', { ok: true, stdout: 'true\n' }, 'enabled'],
    ['command failed', { ok: false, stdout: 'false\n' }, 'unknown'], ['empty', { ok: true, stdout: '' }, 'unknown'], ['not a boolean', { ok: true, stdout: '<no value>' }, 'unknown']]) {
    test(label, async () => {
      const calls = [];
      assert.equal(await LR().liveRestore({ op: async (a, o) => { calls.push([a, o]); return res; } }), want);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0][0], 'info', 'read-only: docker info');
      assert.ok(calls[0][1].timeoutMs > 0 && calls[0][1].timeoutMs <= 10_000, 'bounded');
    });
  }
  test('a probe that throws is unknown', async () => assert.equal(await LR().liveRestore({ op: async () => { throw new Error('x'); } }), 'unknown'));
  test('warning text: enabled and unknown are explicit; disabled says nothing', () => {
    assert.match(LR().warning('enabled'), /live-restore is enabled.*not qualified/s);
    assert.match(LR().warning('unknown'), /could not read.*live-restore.*not qualified/s);
    assert.equal(LR().warning('disabled'), null);
    for (const s of ['enabled', 'unknown']) assert.match(LR().warning(s), /QB does not change/);
  });
});

describe('doctor', () => {
  test('disabled: ok', async () => { const r = await doctor({ agent: 'claude-code', env: {} }, deps('disabled')); assert.equal(get(r).status, 'ok'); assert.equal(r.exitCode, 0); });
  test('enabled: fail (the private-code beta requires it off), with a fix the owner applies', async () => {
    const r = await doctor({ agent: 'claude-code', env: {} }, deps('enabled'));
    assert.equal(get(r).status, 'fail'); assert.equal(r.exitCode, 1); assert.match(get(r).fix, /daemon\.json/);
  });
  test('unknown: an explicit warning, never ok', async () => {
    const r = await doctor({ agent: 'claude-code', env: {} }, deps('unknown'));
    assert.equal(get(r).status, 'warn'); assert.match(get(r).detail, /could not read/);
  });
  test('a doctor probe that throws is unknown', async () => assert.equal(get(await doctor({ agent: 'claude-code', env: {} }, deps('x', { liveRestore: async () => { throw new Error('x'); } }))).status, 'warn'));
  test('skipped without Docker and for agents that do not use the sandbox', async () => {
    assert.equal(get(await doctor({ agent: 'claude-code', env: {} }, deps('enabled', { dockerVersion: async () => null }))).status, 'skip');
    assert.equal(get(await doctor({ agent: 'dry-run', env: {} }, deps('enabled'))).status, 'skip');
  });
});
