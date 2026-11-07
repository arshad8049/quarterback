/**
 * Signup delivery hardening and staging isolation (owner plan rev 3, 2026-11-07).
 *   - A saved signup is never reported as an error because of email: a crash after the atomic
 *     signup+jobs batch still answers "registered", and the cron delivers the jobs exactly once.
 *   - A crash before the batch commits saves nothing; the client's retry succeeds.
 *   - Persistent configuration errors (provider 401/403, no API key) stop at 'blocked_config':
 *     not retried by the cron, observable in the report, and re-queued after the repair.
 *   - Transient errors (5xx, network) stay retryable ('failed').
 *   - EMAIL_MODE=test (staging) never sends, except to an explicit allowlist.
 *   - CORS is scoped: only the signup endpoint answers browsers, and only for ALLOWED_ORIGINS.
 *   - Links in emails use SITE_URL when it is set.
 * Production evidence: Resend 403 "You can only send testing emails to your own email address"
 * made every welcome email retry until 'dead' (D1 qb-beta, 2026-11-07).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const post = (w, body, headers = {}) => w.call('POST', '/api/beta-access', { body, headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } });
const due = (w) => w.db.prepare("UPDATE email_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
const rows = (w) => w.db.prepare('SELECT kind, status, attempts FROM email_deliveries ORDER BY kind').all().map((d) => [d.kind, d.status, d.attempts]);
const sent = (w, kindRe) => w.emails.filter((e) => e.status === 200 && kindRe.test(e.headers['Idempotency-Key'] || '')).length;

describe('signup survives email failures', { skip: SKIP }, () => {
  test('a crash after the batch commits (claiming the job fails) still answers registered; the cron sends each job once', async () => {
    const w = await workerEnv();
    w.d1.faults.push({ match: /SET status = 'sending'/, times: 2 });
    const r = await post(w, { email: 'crash@example.com' });
    assert.equal(r.status, 200, `pre-fix: ${r.status} ${r.text}`);
    assert.deepEqual([r.json.registered, r.json.welcome_email], [true, 'pending_retry']);
    assert.deepEqual(rows(w), [['owner_notify', 'pending', 0], ['welcome', 'pending', 0]]);
    await w.scheduled(); await w.scheduled();
    assert.deepEqual(rows(w).map((x) => x[1]), ['sent', 'sent']);
    assert.equal(sent(w, /^welcome:/), 1);
    assert.equal(sent(w, /^owner-notify:/), 1);
  });

  test('a crash before the batch commits saves nothing (500), and the retry succeeds with one row', async () => {
    const w = await workerEnv();
    w.d1.faults.push({ match: /INSERT INTO email_deliveries/, times: 1 });
    const r1 = await post(w, { email: 'retry@example.com' });
    assert.equal(r1.status, 500);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0, 'the batch is all or nothing');
    const r2 = await post(w, { email: 'retry@example.com' });
    assert.deepEqual([r2.status, r2.json.registered, r2.json.duplicate], [200, true, undefined]);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1);
  });

  test('concurrent duplicates with a failing provider: one row, one job per kind, at most one successful send each', async () => {
    const w = await workerEnv();
    w.control.emailStatus = () => 503;
    const rs = await Promise.all([1, 2, 3].map(() => post(w, { email: 'dup@example.com' })));
    assert.ok(rs.every((r) => r.status === 200 && r.json.registered));
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1);
    assert.deepEqual(rows(w).map((x) => x.slice(0, 2)), [['owner_notify', 'failed'], ['welcome', 'failed']]);
    w.control.emailStatus = () => 200;
    due(w); await Promise.all([w.scheduled(), w.scheduled()]);
    assert.ok(sent(w, /^welcome:/) <= 1 && sent(w, /^owner-notify:/) <= 1);
  });
});

describe('configuration errors stop instead of retrying', { skip: SKIP }, () => {
  for (const status of [401, 403]) {
    test(`provider ${status}: blocked_config, the signup is registered, the cron does not retry`, async () => {
      const w = await workerEnv();
      w.control.emailStatus = () => status;
      const r = await post(w, { email: `cfg${status}@example.com` });
      assert.deepEqual([r.status, r.json.registered, r.json.welcome_email], [200, true, 'not_sent']);
      assert.deepEqual(rows(w), [['owner_notify', 'blocked_config', 1], ['welcome', 'blocked_config', 1]]);
      const calls = w.emails.length;
      due(w); await w.scheduled(); await w.scheduled();
      assert.equal(w.emails.length, calls, 'pre-fix: the cron kept retrying a configuration error until dead');
      const rep = (await w.call('GET', '/api/report', { headers: { Authorization: 'Bearer admin-secret-for-tests' } })).json;
      assert.ok(rep.email_deliveries.recent_failures.some((f) => f.status === 'blocked_config'));
    });
  }

  test('no API key: blocked_config without calling the provider', async () => {
    const w = await workerEnv({ env: { RESEND_API_KEY: '' } });
    const r = await post(w, { email: 'nokey@example.com' });
    assert.deepEqual([r.json.registered, r.json.welcome_email], [true, 'not_sent']);
    assert.equal(w.emails.length, 0);
    assert.deepEqual(rows(w).map((x) => x[1]), ['blocked_config', 'blocked_config']);
  });

  test('after the repair, re-queued jobs are sent exactly once', async () => {
    const w = await workerEnv();
    w.control.emailStatus = () => 403;
    await post(w, { email: 'later@example.com' });
    w.control.emailStatus = () => 200;
    // the documented re-queue (docs/website/signup.md)
    w.db.prepare("UPDATE email_deliveries SET status = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'blocked_config'").run();
    await w.scheduled(); await w.scheduled();
    assert.deepEqual(rows(w).map((x) => x[1]), ['sent', 'sent']);
    assert.equal(sent(w, /^welcome:/), 1);
  });

  test('a 500 or a network error stays retryable (failed), not blocked', async () => {
    const w = await workerEnv();
    w.control.emailStatus = () => 500;
    await post(w, { email: 'transient@example.com' });
    assert.deepEqual(rows(w).map((x) => x[1]), ['failed', 'failed']);
  });
});

describe('staging isolation', { skip: SKIP }, () => {
  test('EMAIL_MODE=test sends nothing and records the delivery as simulated', async () => {
    const w = await workerEnv({ env: { EMAIL_MODE: 'test' } });
    const r = await post(w, { email: 'stage@example.com' });
    assert.deepEqual([r.status, r.json.registered], [200, true]);
    assert.equal(w.emails.length, 0, 'staging sent a real email');
    const d = w.db.prepare("SELECT status, last_error FROM email_deliveries WHERE kind = 'welcome'").get();
    assert.equal(d.status, 'sent');
    assert.match(d.last_error, /simulated/);
  });

  test('EMAIL_MODE=test with EMAIL_ALLOWLIST sends only to listed recipients', async () => {
    const w = await workerEnv({ env: { EMAIL_MODE: 'test', EMAIL_ALLOWLIST: 'owner+stage@example.com' } });
    await post(w, { email: 'owner+stage@example.com' });
    await post(w, { email: 'stranger@example.com' }, { 'CF-Connecting-IP': '203.0.113.8' });
    assert.deepEqual(w.emails.map((e) => e.body.to), ['owner+stage@example.com']);
  });

  test('an unknown EMAIL_MODE fails closed: nothing is sent', async () => {
    const w = await workerEnv({ env: { EMAIL_MODE: 'typo' } });
    await post(w, { email: 'x@example.com' });
    assert.equal(w.emails.length, 0);
    assert.deepEqual(rows(w).map((x) => x[1]), ['blocked_config', 'blocked_config']);
  });

  test('links in emails use SITE_URL', async () => {
    const w = await workerEnv({ env: { SITE_URL: 'https://quarterback-staging.velorallc.workers.dev' } });
    await post(w, { email: 'link@example.com' });
    await w.call('POST', '/api/telemetry/request', { body: { email: 'link@example.com' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    const mail = w.emails.find((e) => /telemetry/i.test(e.body.subject));
    assert.ok(mail, 'a telemetry link was mailed');
    assert.match(mail.body.html, /https:\/\/quarterback-staging\.velorallc\.workers\.dev\/api\/telemetry\/verify\?code=/);
  });
});

describe('CORS is scoped to the signup endpoint and its allowed origins', { skip: SKIP }, () => {
  const ORIGIN = 'https://arshad8049.github.io';
  test('an allowed origin gets its own origin back on preflight and POST', async () => {
    const w = await workerEnv({ env: { ALLOWED_ORIGINS: ORIGIN } });
    const pre = await w.call('OPTIONS', '/api/beta-access', { headers: { Origin: ORIGIN } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const r = await post(w, { email: 'cors@example.com' }, { Origin: ORIGIN });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(r.headers.get('Vary'), 'Origin');
  });

  test('any other origin gets no CORS grant (pre-fix: "*" everywhere); server-side checks still apply', async () => {
    const w = await workerEnv({ env: { ALLOWED_ORIGINS: ORIGIN } });
    const pre = await w.call('OPTIONS', '/api/beta-access', { headers: { Origin: 'https://evil.example' } });
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
    const bad = await post(w, { email: 'nope' }, { Origin: 'https://evil.example' });
    assert.equal(bad.status, 400);
  });

  test('without ALLOWED_ORIGINS (production) no browser origin is granted', async () => {
    const w = await workerEnv();
    const pre = await w.call('OPTIONS', '/api/beta-access', { headers: { Origin: ORIGIN } });
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('telemetry and admin endpoints never send a CORS grant', async () => {
    const w = await workerEnv({ env: { ALLOWED_ORIGINS: ORIGIN } });
    for (const [m, p] of [['POST', '/api/metrics'], ['POST', '/api/telemetry/revoke'], ['GET', '/api/report'], ['POST', '/api/telemetry/request']]) {
      const r = await w.call(m, p, { headers: { Origin: ORIGIN } });
      assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, `${m} ${p}`);
    }
  });
});
