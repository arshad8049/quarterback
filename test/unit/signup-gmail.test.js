/**
 * Email through the owner's Gmail account (owner decision 2026-11-07: no domain, so Resend's
 * sandbox sender can't reach anyone else; "use my personal gmail api with a professional template").
 *   - EMAIL_PROVIDER=gmail exchanges the refresh token, then sends a multipart (text + HTML)
 *     message from GMAIL_SENDER through the Gmail API.
 *   - Missing credentials, a revoked refresh token (invalid_grant) and a 403 that isn't a quota
 *     limit are configuration errors: blocked_config, not retried.
 *   - 5xx, 429 and quota 403s are transient: failed, retried with backoff.
 *   - The access token is cached; a 401 on send drops it so the retry gets a fresh one.
 *   - The welcome email keeps the agreed wording and has a plain-text part; headers can't be
 *     injected through the subject or recipient.
 *   - An unknown EMAIL_PROVIDER sends nothing (fails closed); staging (EMAIL_MODE=test) still
 *     never calls Gmail.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const GMAIL = { EMAIL_PROVIDER: 'gmail', GMAIL_CLIENT_ID: 'cid.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'csecret', GMAIL_REFRESH_TOKEN: '1//refresh', RESEND_API_KEY: '' };
const post = (w, body) => w.call('POST', '/api/beta-access', { body, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
const due = (w) => w.db.prepare("UPDATE email_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
const rows = (w) => w.db.prepare('SELECT kind, status FROM email_deliveries ORDER BY kind').all().map((d) => [d.kind, d.status]);

describe('Gmail provider', { skip: SKIP }, () => {
  test('a signup sends the welcome and the owner notice through the Gmail API from the owner account', async () => {
    const w = await workerEnv({ env: GMAIL });
    const r = await post(w, { email: 'new.user@example.com', agent: 'Claude Code' });
    assert.deepEqual([r.status, r.json.registered, r.json.welcome_email], [200, true, 'sent']);
    assert.deepEqual(rows(w), [['owner_notify', 'sent'], ['welcome', 'sent']]);
    assert.ok(w.emails.every((e) => e.url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'));
    assert.ok(w.emails.every((e) => e.headers.Authorization === 'Bearer ya29.test'));
    const welcome = w.emails.find((e) => e.body.to === 'new.user@example.com');
    assert.equal(welcome.body.from, 'Quarterback by Velora <ashaik8.us@gmail.com>');
    assert.equal(welcome.body.mimeHeaders['Reply-To'], 'ashaik8.us@gmail.com');
    assert.equal(welcome.body.subject, 'You’re on the Quarterback beta list');
    assert.match(welcome.body.mimeHeaders['Content-Type'], /^multipart\/alternative/);
    assert.match(welcome.body.mimeHeaders['List-Unsubscribe'], /^<mailto:ashaik8\.us@gmail\.com\?subject=unsubscribe>$/);
    assert.match(welcome.body.html, /What happens next/);
    assert.match(welcome.body.html, /macOS: limited successful runs; not a validated supported environment/);
    assert.match(welcome.body.text, /What happens next\n1\. /);
    assert.doesNotMatch(welcome.body.text, /<[a-z]/i, 'the text part has no markup');
    const owner = w.emails.find((e) => e.body.to === 'ashaik8.us@gmail.com');
    assert.match(owner.body.subject, /^QB beta signup #1: new\.user@example\.com \(Claude Code\)$/);
    assert.equal(w.control.tokenCalls, 1, 'the access token is cached across the two sends');
  });

  test('the Message-ID is stable per delivery, so a re-sent job collapses in the mailbox', async () => {
    const w = await workerEnv({ env: GMAIL });
    w.control.emailStatus = (n) => (n === 0 ? 503 : 200);
    await post(w, { email: 'msgid@example.com' });
    due(w); await w.scheduled();
    const ids = w.emails.filter((e) => e.body.to === 'msgid@example.com').map((e) => e.body.mimeHeaders['Message-ID']);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.match(ids[0], /^<[0-9a-f]{32}@gmail\.com>$/);
  });

  test('missing Gmail credentials: blocked_config, Google is never called', async () => {
    const w = await workerEnv({ env: { ...GMAIL, GMAIL_REFRESH_TOKEN: '' } });
    const r = await post(w, { email: 'nocreds@example.com' });
    assert.deepEqual([r.status, r.json.registered, r.json.welcome_email], [200, true, 'not_sent']);
    assert.deepEqual(rows(w), [['owner_notify', 'blocked_config'], ['welcome', 'blocked_config']]);
    assert.equal(w.control.tokenCalls + w.emails.length, 0);
  });

  test('a revoked refresh token (invalid_grant) is blocked_config and the cron does not retry it', async () => {
    const w = await workerEnv({ env: GMAIL });
    w.control.tokenStatus = () => 400;
    const r = await post(w, { email: 'revoked@example.com' });
    assert.equal(r.json.welcome_email, 'not_sent');
    assert.deepEqual(rows(w).map((x) => x[1]), ['blocked_config', 'blocked_config']);
    const calls = w.control.tokenCalls;
    due(w); await w.scheduled();
    assert.equal(w.control.tokenCalls, calls);
    const err = w.db.prepare("SELECT last_error FROM email_deliveries WHERE kind = 'welcome'").get().last_error;
    assert.match(err, /Gmail token HTTP 400 invalid_grant/);
    assert.doesNotMatch(err, /refresh|csecret/, 'no secret in the stored error');
  });

  test('Gmail 403 (API disabled or scope missing) is blocked_config; a quota 403 is retried', async () => {
    const w = await workerEnv({ env: GMAIL });
    w.control.emailStatus = () => 403;
    w.control.emailError = '{"error":{"code":403,"message":"Gmail API has not been used in project 1 before or it is disabled."}}';
    await post(w, { email: 'disabled@example.com' });
    assert.deepEqual(rows(w).map((x) => x[1]), ['blocked_config', 'blocked_config']);

    const q = await workerEnv({ env: GMAIL });
    q.control.emailStatus = () => 403;
    q.control.emailError = '{"error":{"code":403,"errors":[{"reason":"dailyLimitExceeded"}]}}';
    await post(q, { email: 'quota@example.com' });
    assert.deepEqual(rows(q).map((x) => x[1]), ['failed', 'failed']);
  });

  for (const status of [429, 500, 503]) {
    test(`Gmail ${status} is transient: failed, then sent by the cron`, async () => {
      const w = await workerEnv({ env: GMAIL });
      w.control.emailStatus = () => status;
      const r = await post(w, { email: `t${status}@example.com` });
      assert.equal(r.json.welcome_email, 'pending_retry');
      assert.deepEqual(rows(w).map((x) => x[1]), ['failed', 'failed']);
      w.control.emailStatus = () => 200;
      due(w); await w.scheduled();
      assert.deepEqual(rows(w).map((x) => x[1]), ['sent', 'sent']);
    });
  }

  test('a 401 on send drops the cached token; the next send exchanges a fresh one', async () => {
    const w = await workerEnv({ env: GMAIL });
    w.control.emailStatus = (n) => (n === 0 ? 401 : 200);
    await post(w, { email: 'stale@example.com' });
    // welcome: token #1, 401 (transient, token dropped); owner notice: token #2, sent
    assert.equal(w.control.tokenCalls, 2);
    assert.deepEqual(rows(w), [['owner_notify', 'sent'], ['welcome', 'failed']]);
    due(w); await w.scheduled();
    assert.deepEqual(rows(w).map((x) => x[1]), ['sent', 'sent']);
  });

  test('CR/LF in the agent field is refused before anything is saved or sent (no header injection)', async () => {
    const w = await workerEnv({ env: GMAIL });
    const r = await post(w, { email: 'inject@example.com', agent: 'x\r\nBcc: victim@example.com' });
    assert.equal(r.status, 400);
    assert.equal(w.emails.length, 0);
    const ok = await post(w, { email: 'inject@example.com', agent: 'Claude Code' });
    assert.equal(ok.status, 200);
    for (const e of w.emails) assert.doesNotMatch(e.body.mime.split('\r\n\r\n')[0], /\r\nBcc:/);
  });

  test('an unknown EMAIL_PROVIDER sends nothing (blocked_config)', async () => {
    const w = await workerEnv({ env: { ...GMAIL, EMAIL_PROVIDER: 'gmial' } });
    await post(w, { email: 'typo@example.com' });
    assert.deepEqual(rows(w).map((x) => x[1]), ['blocked_config', 'blocked_config']);
    assert.equal(w.emails.length + w.control.tokenCalls, 0);
  });

  test('staging (EMAIL_MODE=test) with the Gmail provider never calls Google', async () => {
    const w = await workerEnv({ env: { ...GMAIL, EMAIL_MODE: 'test' } });
    const r = await post(w, { email: 'stage@example.com' });
    assert.equal(r.json.welcome_email, 'simulated');
    assert.equal(w.emails.length + w.control.tokenCalls, 0);
  });

  test('the telemetry link email carries the one-time link in both parts', async () => {
    const w = await workerEnv({ env: GMAIL });
    await post(w, { email: 'tele@example.com' });
    await w.call('POST', '/api/telemetry/request', { body: { email: 'tele@example.com' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    const mail = w.emails.find((e) => /telemetry link/.test(e.body.subject || ''));
    assert.ok(mail, 'telemetry link sent');
    assert.match(mail.body.html, /verify\?code=[0-9a-f]{64}/);
    assert.match(mail.body.text, /verify\?code=[0-9a-f]{64}/);
  });
});
