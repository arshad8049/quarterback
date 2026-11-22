/**
 * The old-host compatibility Worker: page visits move with their path and query; API calls
 * and non-GET requests get 410, never a redirect; the Worker never logs.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SRC = path.join(__dirname, '..', '..', 'tools', 'old-host-redirect', 'worker.js');
async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-oldhost-'));
  fs.copyFileSync(SRC, path.join(dir, 'w.mjs'));
  return (await import(pathToFileURL(path.join(dir, 'w.mjs')).href)).default;
}
const OLD = 'https://quaterback.velorallc.workers.dev';

test('page visits get a 301 to the same path and query on the new host', async () => {
  const w = await load();
  for (const [m, p] of [['GET', '/'], ['GET', '/developers?x=1#y'], ['HEAD', '/privacy.html'], ['GET', '/evidence/2026-10-15-hero-run/hero-run.log']]) {
    const r = await w.fetch(new Request(OLD + p, { method: m }));
    assert.equal(r.status, 301, `${m} ${p}`);
    const u = new URL(OLD + p);
    assert.equal(r.headers.get('Location'), 'https://quarterback.velorallc.workers.dev' + u.pathname + u.search);
  }
});

test('API calls and non-GET methods are 410, never redirected', async () => {
  const w = await load();
  for (const [m, p] of [['POST', '/api/metrics'], ['GET', '/api/telemetry/verify?code=' + 'a'.repeat(64)], ['POST', '/api/telemetry/revoke'], ['POST', '/api/beta-access'], ['POST', '/'], ['OPTIONS', '/api/beta-access'], ['GET', '/api']]) {
    const r = await w.fetch(new Request(OLD + p, { method: m, headers: { Authorization: 'Bearer qbt_secret' } }));
    assert.equal(r.status, 410, `${m} ${p}`);
    assert.equal(r.headers.get('Location'), null);
    assert.doesNotMatch(await r.text(), /qbt_secret|aaaa/);
  }
});

test('the Worker contains no logging', () => {
  assert.doesNotMatch(fs.readFileSync(SRC, 'utf8'), /console\./);
});
