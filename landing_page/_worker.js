/**
 * Quarterback landing — Cloudflare Worker
 *
 * Handles API routes, then falls through to static assets for everything else.
 * Bindings required (set in Cloudflare dashboard → Workers → Settings):
 *   DB           — D1 database  (qb-beta)
 *   RESEND_API_KEY — secret env var (EMAIL_PROVIDER=resend)
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — secrets (EMAIL_PROVIDER=gmail)
 *   ADMIN_SECRET   — secret env var
 * Optional vars (wrangler.toml; the staging environment sets them):
 *   SITE_URL        — base URL used in email links (default: the production workers.dev host)
 *   EMAIL_MODE      — 'live' (default) or 'test'. 'test' records deliveries as simulated and never
 *                     sends, except to EMAIL_ALLOWLIST. Any other value sends nothing (fails closed).
 *   EMAIL_ALLOWLIST — comma-separated recipients that EMAIL_MODE=test may really send to
 *   EMAIL_PROVIDER  — 'resend' (default) or 'gmail' (the owner's Gmail account, no domain needed)
 *   GMAIL_SENDER    — From address for 'gmail' (default: the owner's address)
 *   ALLOWED_ORIGINS — comma-separated browser origins allowed to call POST /api/beta-access
 *                     cross-origin. Unset in production: the site's own form is same-origin.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const FROM       = 'Quarterback Beta <onboarding@resend.dev>';
const DEFAULT_SITE = 'https://quarterback.velorallc.workers.dev';
const siteUrl = (env) => (env && env.SITE_URL) || DEFAULT_SITE;
const OWNER      = 'ashaik8.us@gmail.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Block direct access to worker source files
    if (url.pathname.startsWith('/functions/') || url.pathname === '/_worker.js') {
      return new Response('Not found', { status: 404 });
    }

    // ── API routes ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/beta-access') {
      // CORS is granted only here, and only to ALLOWED_ORIGINS (CORS limits browsers; the
      // server-side validation, size limit and per-IP rate limit apply to every caller).
      return withCors(request, env, await handleBetaAccess(request, env));
    }
    if (url.pathname === '/api/metrics') {
      return handleMetrics(request, env);
    }
    if (url.pathname === '/api/telemetry/request') {
      return handleTelemetryRequest(request, env);
    }
    if (url.pathname === '/api/telemetry/verify') {
      return handleTelemetryVerify(request, env);
    }
    if (url.pathname === '/api/telemetry/revoke') {
      return handleTelemetryRevoke(request, env);
    }
    if (url.pathname === '/api/telemetry/delete') {
      return handleTelemetryDelete(request, env);
    }
    if (url.pathname === '/api/report') {
      return handleReport(request, env);
    }
    if (url.pathname === '/api/submissions') {
      return handleSubmissions(request, env);
    }

    // ── Static assets fallback ────────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },

  // QB-35: durable email delivery — retry pending/failed deliveries (wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    await retryDeliveries(env);
    await applyRetention(env);   // QB-32
  },
};

// ─── POST /api/beta-access (QB-35) ────────────────────────────────────────────
//
// Input: a JSON object of at most 2 KiB with only `email` (string, ≤ 254, an address) and
// optional `agent` (string ≤ 80, no control characters) — anything else is a defined 400/413,
// never an exception. Abuse: at most 10 attempts per IP per hour (the IP is stored only as a
// sha256). Registration is atomic (INSERT … ON CONFLICT(email) DO NOTHING): concurrent
// duplicates create one row. Registration is tracked separately from email DELIVERY: each
// email is a row in email_deliveries with an idempotency key (welcome:<email>,
// owner-notify:<email>), sent with that key, and retried by the cron handler with backoff
// until sent or dead. A configuration error (no API key, provider 401/403) is not retried:
// the job stops at 'blocked_config' until the configuration is repaired and the job re-queued
// (docs/website/signup.md). Once the signup is saved, nothing about email can turn the
// response into an error. The response says whether the welcome email was actually sent.

const MAX_SIGNUP_BYTES = 2048;
const MAX_SIGNUPS_PER_IP_HOUR = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DELIVERY_ATTEMPTS = 6;

/** { email, agent } or { error } — strict, never throws. */
function signupInput(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'body must be a JSON object' };
  for (const k of Object.keys(b)) if (k !== 'email' && k !== 'agent') return { error: `unknown field: ${k}` };
  if (typeof b.email !== 'string') return { error: 'email must be a string' };
  const email = b.email.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { error: 'Invalid email' };
  let agent = null;
  if (b.agent !== undefined && b.agent !== null) {
    if (typeof b.agent !== 'string') return { error: 'agent must be a string' };
    if (b.agent.length > 80 || /[\u0000-\u001f\u007f]/.test(b.agent)) return { error: 'agent must be at most 80 printable characters' };
    agent = b.agent.trim() || null;
  }
  return { email, agent };
}

async function handleBetaAccess(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const r = await boundedJson(request, MAX_SIGNUP_BYTES);
  if (r.error) return json({ error: r.error }, r.status);
  const input = signupInput(r.body);
  if (input.error) return json({ error: input.error }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256Hex(`qb-signup:${ip}`);
  if (!(await admit(env, 'signup_attempts', 'ip_hash', ipHash, MAX_SIGNUPS_PER_IP_HOUR))) return json({ error: 'Too many requests' }, 429);

  const referrer = (request.headers.get('Referer') || '').slice(0, 512) || null;
  const now = new Date().toISOString();
  const welcomeKey = `welcome:${input.email}`; const ownerKey = `owner-notify:${input.email}`;
  // A delivery that already completed (sent, or closed as dead / legacy) is never queued again,
  // even after retention removed its row: delivery_completions outlives the delivery rows.
  const queue = `INSERT INTO email_deliveries (idempotency_key, kind, recipient, payload, status, attempts, created_at, next_attempt_at)
    SELECT ?, ?, ?, ?, 'pending', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM delivery_completions WHERE key_hash = ?)
    ON CONFLICT(idempotency_key) DO NOTHING`;
  // QB-35 re-review: the registration and BOTH delivery intents commit atomically (one D1 batch =
  // one transaction): a failure anywhere leaves neither, and the client can simply retry. The
  // enqueues are idempotent and run for duplicates too, so a registration that is missing its
  // jobs (e.g. made by an older worker) is repaired without re-sending completed jobs.
  const [ins] = await env.DB.batch([
    env.DB.prepare('INSERT INTO submissions (email, agent, ip, referrer) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
      .bind(input.email, input.agent, ip === 'unknown' ? null : ip, referrer),
    env.DB.prepare(queue).bind(welcomeKey, 'welcome', input.email, '{}', now, now, await deliveryHash(welcomeKey)),
    env.DB.prepare(queue).bind(ownerKey, 'owner_notify', OWNER, JSON.stringify({ email: input.email, agent: input.agent, ip: ip === 'unknown' ? null : ip, referrer }), now, now, await deliveryHash(ownerKey)),
  ]);
  const duplicate = !ins.meta || ins.meta.changes !== 1;
  // Sends happen outside the transaction; only pending/failed jobs are claimed, so completed
  // jobs are never re-sent (and each send carries its idempotency key).
  // The signup and both jobs are committed. A failure from here on (claiming, sending,
  // recording) leaves the jobs pending for the cron; it never turns this into an error.
  let results = {};
  try { results = await sendDeliveries(env, [welcomeKey, ownerKey]); } catch { results = {}; }
  if (duplicate) return json({ ok: true, registered: true, duplicate: true });
  const w = results[welcomeKey];
  // sent | simulated (staging) | not_sent (blocked by configuration) | pending_retry (anything else)
  const WELCOME = { sent: 'sent', simulated: 'simulated', blocked_config: 'not_sent' };
  return json({ ok: true, registered: true, welcome_email: WELCOME[w] || 'pending_retry' });
}

/** Claim and send the given deliveries (idempotent). Returns { key: status }. */
async function sendDeliveries(env, keys) {
  const out = {};
  for (const key of keys) {
    // One job's database or provider error must not stop the others; a job whose claim or
    // bookkeeping fails stays as it was (or 'sending', reclaimed after 10 minutes) for the cron.
    try { out[key] = await sendOne(env, key); } catch { out[key] = 'pending_retry'; }
  }
  return out;
}

/** Claim, send and record one delivery job. Returns its status. */
async function sendOne(env, key) {
  const now = new Date().toISOString();
  // claim: only a pending/failed row that is due moves to 'sending' (one sender at a time)
  const claim = await env.DB.prepare(`UPDATE email_deliveries SET status = 'sending', claimed_at = ?
    WHERE idempotency_key = ? AND status IN ('pending', 'failed') AND next_attempt_at <= ?`).bind(now, key, now).run();
  if (!claim.meta || claim.meta.changes !== 1) {
    const row = await env.DB.prepare('SELECT status FROM email_deliveries WHERE idempotency_key = ?').bind(key).first();
    return row ? row.status : 'missing';
  }
  const d = await env.DB.prepare('SELECT id, kind, recipient, payload, attempts FROM email_deliveries WHERE idempotency_key = ?').bind(key).first();
  let res;
  try { res = await deliver(d, key, env); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  const attempts = d.attempts + 1;
  if (res.ok) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE email_deliveries SET status = 'sent', attempts = ?, sent_at = ?, last_error = ? WHERE id = ?`)
        .bind(attempts, new Date().toISOString(), res.simulated ? 'simulated (EMAIL_MODE=test): not sent' : null, d.id),
      await completion(env, key, 'sent'),
    ]);
    return res.simulated ? 'simulated' : 'sent';
  } else if (res.config) {
    // A configuration error repeats until someone fixes it: stop here, do not retry, and keep
    // no completion record so the job can be re-queued after the repair.
    await env.DB.prepare(`UPDATE email_deliveries SET status = 'blocked_config', attempts = ?, last_error = ? WHERE id = ?`)
      .bind(attempts, String(res.error || 'email configuration error').slice(0, 300), d.id).run();
    return 'blocked_config';
  } else {
    const dead = attempts >= MAX_DELIVERY_ATTEMPTS;
    const backoff = Math.min(6 * 3600 * 1000, 60 * 1000 * 2 ** attempts);
    const update = env.DB.prepare(`UPDATE email_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
      .bind(dead ? 'dead' : 'failed', attempts, String(res.error || 'send failed').slice(0, 300), isoIn(backoff), d.id);
    await env.DB.batch(dead ? [update, await completion(env, key, 'dead')] : [update]);
    return dead ? 'dead' : 'failed';
  }
}

// Durable delivery completion (QB-35 re-review 2): one row per completed delivery, keyed by a
// sha256 of its idempotency key — no address, payload or log. It is kept after retention removes
// the delivery row, so a completed (or legacy-suppressed) delivery is never queued again, while a
// registration whose jobs were never enqueued is still repaired.
const deliveryHash = (key) => sha256Hex(`qb-delivery:${key}`);
async function completion(env, key, outcome) {
  return env.DB.prepare('INSERT INTO delivery_completions (key_hash, outcome, completed_at) VALUES (?, ?, ?) ON CONFLICT(key_hash) DO NOTHING')
    .bind(await deliveryHash(key), outcome, new Date().toISOString());
}

async function deliver(d, key, env) {
  if (d.kind === 'welcome') return sendWelcome(env, d.recipient, key);
  if (d.kind === 'owner_notify') {
    const p = JSON.parse(d.payload || '{}');
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM submissions').first();
    return sendOwnerNotify(env, p.email, p.agent, count, p.ip, p.referrer, key);
  }
  return { ok: false, error: `unknown delivery kind ${d.kind}` };
}

/** Cron: retry due pending/failed deliveries; a send stuck in 'sending' > 10 min is retried. */
async function retryDeliveries(env) {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`UPDATE email_deliveries SET status = 'failed', last_error = 'interrupted while sending'
    WHERE status = 'sending' AND claimed_at < ?`).bind(stale).run();
  const due = await env.DB.prepare(`SELECT idempotency_key FROM email_deliveries
    WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY id LIMIT 50`).bind(new Date().toISOString()).all();
  return sendDeliveries(env, due.results.map((r) => r.idempotency_key));
}

// ─── Telemetry credentials (QB-33) ────────────────────────────────────────────
//
// A registered email alone authorizes nothing. To send metrics a user proves control of the
// email: POST /api/telemetry/request mails a one-time link (expires in 30 min); opening it
// (GET /api/telemetry/verify?code=…) issues a revocable token, shown once, scoped to
// `metrics:write`. Only sha256 hashes of codes and tokens are stored. POST
// /api/telemetry/revoke (with the token) revokes it.

const TOKEN_PREFIX = 'qbt_';
const CODE_TTL_MS = 30 * 60 * 1000;
const MAX_CODE_REQUESTS_PER_HOUR = 3;
const MAX_METRICS_PER_HOUR = 60;
const MAX_METRICS_BODY_BYTES = 4096;

/**
 * Quota admission atomic with its write (QB-33 re-review 2): one INSERT … SELECT … WHERE count < max.
 * A single statement runs alone on D1 (and in SQLite), so two concurrent requests at the limit
 * cannot both pass a separate COUNT. Returns true when the attempt was recorded (admitted).
 * `table` and `column` are constants from this file, never request input.
 */
async function admit(env, table, column, value, max) {
  const r = await env.DB.prepare(`INSERT INTO ${table} (${column}, created_at) SELECT ?, ?
    WHERE (SELECT COUNT(*) FROM ${table} WHERE ${column} = ? AND created_at > ?) < ?`)
    .bind(value, new Date().toISOString(), value, hourAgo(), max).run();
  return Boolean(r.meta && r.meta.changes === 1);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
const hourAgo = () => new Date(Date.now() - 3600 * 1000).toISOString();

/**
 * Read a JSON body with a HARD size limit (QB-33 re-review): the body is consumed as a stream,
 * counting bytes, and the read is cancelled as soon as the limit is passed — a chunked body
 * without Content-Length is never buffered beyond the limit. Returns { body } or { error, status }.
 */
async function boundedJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (request.headers.has('Content-Length') && Number.isFinite(declared) && declared > maxBytes) return { error: 'Payload too large', status: 413 };
  if (!request.body) return { error: 'Invalid JSON', status: 400 };
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('payload too large'); } catch { /* already closed */ }
        return { error: 'Payload too large', status: 413 };
      }
      chunks.push(value);
    }
  } catch { return { error: 'Unreadable body', status: 400 }; }
  const buf = new Uint8Array(total); let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return { error: 'Invalid JSON', status: 400 }; }
  try { return { body: JSON.parse(text) }; } catch { return { error: 'Invalid JSON', status: 400 }; }
}

async function handleTelemetryRequest(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const r = await boundedJson(request, 1024);
  if (r.error) return json({ error: r.error }, r.status);
  const email = r.body && typeof r.body.email === 'string' ? r.body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400);
  // No enumeration (re-review): EVERY address — registered or not — is counted and limited the
  // same way, BEFORE registration is looked up, and gets the same answers (202, then 429).
  const accepted = json({ ok: true, message: 'If this email is registered, a one-time link has been sent.' }, 202);
  const emailHash = await sha256Hex(`qb-telemetry-request:${email}`);
  if (!(await admit(env, 'telemetry_link_requests', 'email_hash', emailHash, MAX_CODE_REQUESTS_PER_HOUR))) return json({ error: 'Too many requests' }, 429);
  const registered = await env.DB.prepare('SELECT id FROM submissions WHERE email = ?').bind(email).first();
  if (!registered) return accepted;
  const code = randomHex(32);
  await env.DB.prepare('INSERT INTO telemetry_verifications (code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(code), email, new Date().toISOString(), isoIn(CODE_TTL_MS)).run();
  await sendTelemetryLink(env, email, `${siteUrl(env)}/api/telemetry/verify?code=${code}`);
  return accepted;
}

async function handleTelemetryVerify(request, env) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const code = new URL(request.url).searchParams.get('code') || '';
  if (!/^[0-9a-f]{64}$/.test(code)) return json({ error: 'Invalid or expired link' }, 400);
  const row = await env.DB.prepare('SELECT id, email, expires_at, used_at FROM telemetry_verifications WHERE code_hash = ?').bind(await sha256Hex(code)).first();
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) return json({ error: 'Invalid or expired link' }, 400);
  // One use: mark used only if still unused (a concurrent second click gets nothing).
  const used = await env.DB.prepare('UPDATE telemetry_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(new Date().toISOString(), row.id).run();
  if (!used.meta || used.meta.changes !== 1) return json({ error: 'Invalid or expired link' }, 400);
  const token = `${TOKEN_PREFIX}${randomHex(32)}`;
  await env.DB.prepare('INSERT INTO telemetry_tokens (token_hash, email, scope, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), row.email, 'metrics:write', new Date().toISOString()).run();
  return new Response(JSON.stringify({ ok: true, token, scope: 'metrics:write',
    note: 'Shown once. Set QB_TELEMETRY_TOKEN to this value. Revoke: POST /api/telemetry/revoke with Authorization: Bearer <token>.' }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** The token row for a request's bearer token with `scope`, or null. */
async function bearer(request, env, scope) {
  const m = /^Bearer\s+(qbt_[0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const row = await env.DB.prepare('SELECT id, email, scope, revoked_at FROM telemetry_tokens WHERE token_hash = ?').bind(await sha256Hex(m[1])).first();
  if (!row || row.revoked_at || row.scope !== scope) return null;
  return row;
}

async function handleTelemetryRevoke(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const tok = await bearer(request, env, 'metrics:write');
  if (!tok) return json({ error: 'Unauthorized' }, 401);
  await env.DB.prepare('UPDATE telemetry_tokens SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), tok.id).run();
  return json({ ok: true, revoked: true });
}

// ─── Deletion and retention (QB-32) ───────────────────────────────────────────
//
// A telemetry token holder can delete every metric sent with that token (and the token is
// revoked) — no email to the owner needed. Retention (enforced by the cron handler):
// client metrics 180 days; used/expired verification codes 7 days; signup rate-limit rows
// 2 days; sent/dead email deliveries 30 days (their completion — a hash and an outcome — is kept,
// so retention never causes a second welcome; QB-35 re-review 2).

const RETENTION = { client_metrics_days: 180, verifications_days: 7, signup_attempts_days: 2, deliveries_days: 30 };
const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

async function handleTelemetryDelete(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const tok = await bearer(request, env, 'metrics:write');
  if (!tok) return json({ error: 'Unauthorized' }, 401);
  // One transaction (D1 batch): revoke, then delete. Any upload that has not inserted yet now
  // fails its atomic "token still active" condition; any that already inserted is deleted here.
  // If either statement fails, neither applies and the caller gets an error (retry is safe).
  const [, del] = await env.DB.batch([
    env.DB.prepare('UPDATE telemetry_tokens SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), tok.id),
    env.DB.prepare('DELETE FROM client_metrics WHERE token_id = ?').bind(tok.id),
  ]);
  return json({ ok: true, deleted_metrics: del.meta ? del.meta.changes : null, token_revoked: true });
}

async function applyRetention(env) {
  await env.DB.prepare('DELETE FROM client_metrics WHERE created_at < ?').bind(daysAgo(RETENTION.client_metrics_days)).run();
  await env.DB.prepare('DELETE FROM telemetry_verifications WHERE created_at < ?').bind(daysAgo(RETENTION.verifications_days)).run();
  await env.DB.prepare('DELETE FROM telemetry_link_requests WHERE created_at < ?').bind(daysAgo(RETENTION.verifications_days)).run();
  await env.DB.prepare('DELETE FROM signup_attempts WHERE created_at < ?').bind(daysAgo(RETENTION.signup_attempts_days)).run();
  // Sent/dead delivery rows (address, payload, log) are deleted, but each one's completion is
  // recorded first, in the same transaction — including the migration's legacy markers and rows
  // written before delivery_completions existed — so the delete never re-opens a delivery.
  const expired = await env.DB.prepare("SELECT id, idempotency_key, status FROM email_deliveries WHERE status IN ('sent', 'dead') AND created_at < ?")
    .bind(daysAgo(RETENTION.deliveries_days)).all();
  for (const d of expired.results) {
    await env.DB.batch([await completion(env, d.idempotency_key, d.status), env.DB.prepare('DELETE FROM email_deliveries WHERE id = ?').bind(d.id)]);
  }
}

// ─── POST /api/metrics (QB-33) ────────────────────────────────────────────────
//
// Authorization: a verified, unrevoked `metrics:write` token — never an email.
// The body is validated strictly: only known fields, exact types, bounds; a run id is
// accepted once (replay protection); at most MAX_METRICS_PER_HOUR per token. Every row is
// stored as `client_reported`: it is what a client says, not an independently verified result.

const LAYERS_RE = /^L[1-5](,L[1-5]){0,4}$/;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METRIC_FIELDS = {
  run_id:       (v) => typeof v === 'string' && RUN_ID_RE.test(v),
  passed:       (v) => typeof v === 'boolean',
  attempts:     (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  duration_ms:  (v) => Number.isInteger(v) && v >= 0 && v <= 24 * 3600 * 1000,
  repair_count: (v) => Number.isInteger(v) && v >= 0 && v <= 19,
  layers_used:  (v) => typeof v === 'string' && LAYERS_RE.test(v) && new Set(v.split(',')).size === v.split(',').length,
  qb_version:   (v) => typeof v === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(v),
};
const REQUIRED_METRICS = ['run_id', 'passed', 'attempts', 'duration_ms', 'repair_count', 'qb_version'];

/** Validation errors for a metrics body (empty = valid). */
function metricsErrors(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['body must be a JSON object'];
  const errors = [];
  for (const k of Object.keys(b)) if (!METRIC_FIELDS[k]) errors.push(`unknown field: ${k}`);
  for (const k of REQUIRED_METRICS) if (!(k in b)) errors.push(`missing field: ${k}`);
  for (const [k, ok] of Object.entries(METRIC_FIELDS)) if (k in b && !ok(b[k])) errors.push(`invalid ${k}`);
  if (!errors.length && b.repair_count > b.attempts - 1) errors.push('repair_count exceeds attempts - 1');
  return errors;
}

async function handleMetrics(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const tok = await bearer(request, env, 'metrics:write');
  if (!tok) return json({ error: 'Unauthorized: a verified telemetry token is required (an email is not a credential)' }, 401);
  const r = await boundedJson(request, MAX_METRICS_BODY_BYTES);
  if (r.error) return json({ error: r.error }, r.status);
  const errors = metricsErrors(r.body);
  if (errors.length) return json({ error: 'Invalid metrics', details: errors }, 400);
  const b = r.body;
  try {
    // Atomic with revocation (QB-32/33 re-review) AND with the hourly quota (re-review 2): the row
    // is inserted only if, at the moment of the insert, the token is still active and fewer than
    // MAX_METRICS_PER_HOUR rows exist for it — one statement, so concurrent uploads at the limit
    // cannot both pass a separate count.
    const ins = await env.DB.prepare(`INSERT INTO client_metrics
      (run_id, token_id, passed, attempts, duration_ms, repair_count, layers_used, qb_version, source, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'client_reported', ?
      WHERE EXISTS (SELECT 1 FROM telemetry_tokens WHERE id = ? AND revoked_at IS NULL AND scope = 'metrics:write')
        AND (SELECT COUNT(*) FROM client_metrics WHERE token_id = ? AND created_at > ?) < ?`)
      .bind(b.run_id, tok.id, b.passed ? 1 : 0, b.attempts, b.duration_ms, b.repair_count, b.layers_used ?? null, b.qb_version, new Date().toISOString(),
        tok.id, tok.id, hourAgo(), MAX_METRICS_PER_HOUR).run();
    if (!ins.meta || ins.meta.changes !== 1) {
      // Nothing inserted: say why. This read only classifies the refusal; it admits nothing.
      const active = await env.DB.prepare("SELECT 1 AS ok FROM telemetry_tokens WHERE id = ? AND revoked_at IS NULL AND scope = 'metrics:write'").bind(tok.id).first();
      return active ? json({ error: 'Too many requests' }, 429) : json({ error: 'Unauthorized: the telemetry token was revoked' }, 401);
    }
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return json({ error: 'Duplicate run_id' }, 409);
    throw e;
  }
  return json({ ok: true, source: 'client_reported' });
}

// ─── Admin endpoints (QB-34) ──────────────────────────────────────────────────
//
// Authentication: `Authorization: Bearer <ADMIN_SECRET>` only, compared in constant time.
// A credential in the query string is REFUSED (even a correct one): URLs end up in browser
// history, proxies and logs. Every admin response — including 400/401 — is `no-store` and
// carries no CORS grant, and an unauthorized request never receives signup data. Results are
// paginated (`limit` ≤ 500, `cursor` = the last id seen). CSV cells are inert text in
// spreadsheet clients (formula prefixes neutralized).

const ADMIN_HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const adminJson = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS } });

/** null if authorized, else the refusal Response. */
async function adminAuth(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.has('secret') || url.searchParams.has('token') || url.searchParams.has('key')) {
    return adminJson({ error: 'Credentials in the URL are not accepted; send Authorization: Bearer <secret>' }, 400);
  }
  if (request.method !== 'GET') return adminJson({ error: 'Method not allowed' }, 405);
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !env.ADMIN_SECRET) return adminJson({ error: 'Unauthorized' }, 401);
  // constant-time: compare fixed-length digests
  const [a, b] = await Promise.all([sha256Hex(m[1]), sha256Hex(env.ADMIN_SECRET)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0 ? null : adminJson({ error: 'Unauthorized' }, 401);
}

/** { limit, cursor } from the query, or a 400 Response. */
function page(url) {
  const lim = url.searchParams.get('limit'); const cur = url.searchParams.get('cursor');
  const limit = lim === null ? 100 : Number(lim);
  const cursor = cur === null ? null : Number(cur);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { error: adminJson({ error: 'limit must be an integer 1..500' }, 400) };
  if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) return { error: adminJson({ error: 'cursor must be a positive integer id' }, 400) };
  return { limit, cursor };
}

async function signupPage(env, { limit, cursor }) {
  const rows = cursor === null
    ? await env.DB.prepare('SELECT id, email, agent, created_at, ip, referrer FROM submissions ORDER BY id DESC LIMIT ?').bind(limit + 1).all()
    : await env.DB.prepare('SELECT id, email, agent, created_at, ip, referrer FROM submissions WHERE id < ? ORDER BY id DESC LIMIT ?').bind(cursor, limit + 1).all();
  const results = rows.results.slice(0, limit);
  return { results, next_cursor: rows.results.length > limit ? results[results.length - 1].id : null };
}

// ─── GET /api/report ─────────────────────────────────────────────────────────

async function handleReport(request, env) {
  const denied = await adminAuth(request, env);
  if (denied) return denied;
  const p = page(new URL(request.url));
  if (p.error) return p.error;
  const [signups, runs, summary] = await Promise.all([
    signupPage(env, p),
    env.DB.prepare(
      'SELECT run_id, passed, attempts, duration_ms, repair_count, layers_used, qb_version, source, created_at FROM client_metrics ORDER BY id DESC LIMIT ?'
    ).bind(p.limit).all(),
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM submissions)                             AS total_signups,
        COUNT(*)                                                       AS total_runs,
        ROUND(100.0 * SUM(passed) / NULLIF(COUNT(*), 0), 1)           AS pass_rate_pct,
        ROUND(AVG(attempts), 2)                                        AS avg_attempts,
        ROUND(AVG(duration_ms))                                        AS avg_duration_ms,
        ROUND(AVG(repair_count), 2)                                    AS avg_repairs
      FROM client_metrics
    `).first(),
  ]);

  // QB-33: these numbers are what clients reported — never independently verified results.
  return adminJson({
    client_reported: {
      label: 'Client-reported run outcomes (authenticated, schema-validated, NOT independently verified). Not benchmark evidence.',
      summary, metrics: runs.results,
    },
    signups: signups.results,
    next_cursor: signups.next_cursor,
    // QB-35: email delivery is observable — counts by status and the latest failures
    email_deliveries: {
      by_status: (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM email_deliveries GROUP BY status ORDER BY status').all()).results,
      recent_failures: (await env.DB.prepare(`SELECT kind, recipient, status, attempts, last_error, next_attempt_at FROM email_deliveries
        WHERE status IN ('failed', 'dead', 'blocked_config') ORDER BY id DESC LIMIT 20`).all()).results,
    },
  });
}

// ─── GET /api/submissions ────────────────────────────────────────────────────

/** A CSV cell that spreadsheet clients open as inert text (formula prefixes neutralized). */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r\n＝＋－＠]/.test(s)) s = `'${s}`;   // QB-34: also LF
  return `"${s.replace(/"/g, '""')}"`;
}

async function handleSubmissions(request, env) {
  const denied = await adminAuth(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const p = page(url);
  if (p.error) return p.error;
  const fmt = url.searchParams.get('format') || 'json';
  if (fmt !== 'json' && fmt !== 'csv') return adminJson({ error: 'format must be json or csv' }, 400);
  const { results, next_cursor } = await signupPage(env, p);

  if (fmt === 'csv') {
    const header = 'id,email,agent,created_at,ip,referrer\r\n';
    const rows = results.map((r) => [r.id, r.email, r.agent, r.created_at, r.ip, r.referrer].map(csvCell).join(',')).join('\r\n');
    return new Response(header + rows, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="qb-beta-signups.csv"',
        ...(next_cursor !== null ? { 'X-Next-Cursor': String(next_cursor) } : {}),
        ...ADMIN_HEADERS,
      },
    });
  }
  return adminJson({ count: results.length, signups: results, next_cursor });
}

// ─── Email helpers ────────────────────────────────────────────────────────────
//
// One layout for every email: table-based, inline styles, light background (dark mode in mail
// clients inverts light designs cleanly; it mangles dark ones), a hidden preheader, and a
// plain-text version sent alongside the HTML.

const BRAND = { ink: '#14201C', body: '#3B4A44', muted: '#6B7A74', line: '#E3E8E5', accent: '#2F7D62', warm: '#B8642B', bg: '#F4F6F5' };

function emailLayout({ preheader, heading, bodyHtml, footerHtml, site }) {
  const b = BRAND;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:${b.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${b.bg};">${escHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${b.bg};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border:1px solid ${b.line};border-radius:10px;">
    <tr><td style="padding:28px 36px 0 36px;font-family:Helvetica,Arial,sans-serif;">
      <span style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${b.accent};">Quarterback</span>
      <span style="font-size:13px;color:${b.muted};">&nbsp;by Velora</span>
    </td></tr>
    <tr><td style="padding:20px 36px 8px 36px;font-family:Helvetica,Arial,sans-serif;">
      <h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:600;color:${b.ink};">${escHtml(heading)}</h1>
    </td></tr>
    <tr><td style="padding:8px 36px 28px 36px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:${b.body};">
${bodyHtml}
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
    <tr><td style="padding:18px 36px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${b.muted};text-align:center;">
      ${footerHtml}<br><a href="${escHtml(site)}" style="color:${b.muted};">${escHtml(site.replace(/^https:\/\//, ''))}</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const P = (html) => `      <p style="margin:0 0 16px 0;">${html}</p>`;
const button = (href, label) => `      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;"><tr>
        <td style="background:${BRAND.accent};border-radius:6px;"><a href="${escHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">${escHtml(label)}</a></td>
      </tr></table>`;
const panel = (title, html) => `      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0;background:${BRAND.bg};border-radius:8px;"><tr><td style="padding:18px 22px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.warm};margin-bottom:10px;">${escHtml(title)}</div>
${html}
      </td></tr></table>`;

const SETUP_GUIDE = 'https://github.com/arshad8049/quarterback/blob/main/docs/onboarding.md';

function welcomeEmail(env) {
  const SITE = siteUrl(env);
  const code = (t) => `<code style="font-family:Menlo,Consolas,monospace;font-size:13px;background:${BRAND.bg};padding:1px 5px;border-radius:3px;color:${BRAND.ink};">${t}</code>`;
  const steps = [
    ['Follow the setup guide. It installs Quarterback from the main branch and takes you, step by step, from a fresh machine to a verified demo run.', null],
    ['Note the version you installed: the guide shows you how (', ') in step 2. Include it in any feedback.'],
    ['Try it on one real task in your own project, then reply to this email with what helped and what didn\u2019t.', null],
  ];
  const stepHtml = (s) => (s[1] === null ? escHtml(s[0]) : `${escHtml(s[0])}${code('git rev-parse --short HEAD')}${escHtml(s[1])}`);
  const stepText = (s) => (s[1] === null ? s[0] : `${s[0]}git rev-parse --short HEAD${s[1]}`);
  const bodyHtml = [
    P('Thanks for signing up to try Quarterback. It runs Claude Code against a requirements list you approve, checks the change with your tests and the agreed checks, and gives you the evidence and a patch to review. You decide whether to apply it.'),
    button(SETUP_GUIDE, 'Open the setup guide'),
    panel('How to get started', `        <ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:${BRAND.body};">
${steps.map((s) => `          <li style="margin:0 0 8px 0;">${stepHtml(s)}</li>`).join('\n')}
        </ol>`),
    P(`<strong style="color:${BRAND.ink};">Supported today:</strong> Claude Code on JavaScript or Node.js projects tested with node:test. The validated setup is Ubuntu 24.04 with Docker and 16 GB of RAM. macOS: limited successful runs; not a validated supported environment. You also need a Claude subscription or an API key.`),
    P(`Quarterback is pre-release, and <strong style="color:${BRAND.ink};">main</strong> changes as we fix things. If a step doesn\u2019t match what you see, reply with the step number and the output and we\u2019ll help. <a href="${escHtml(SITE)}" style="color:${BRAND.accent};">See how Quarterback works</a>.`),
    P(`<span style="font-size:13px;color:${BRAND.muted};">Privacy: during a Claude Code run, your task and the code the agent reads go to Anthropic under your own Claude account. Quarterback\u2019s own model calls run locally by default. Telemetry is off unless you turn it on. Details: <a href="${escHtml(SITE)}/privacy.html" style="color:${BRAND.accent};">privacy</a>.</span>`),
    `      <p style="margin:0;">Arshad<br><span style="color:${BRAND.muted};">Velora</span></p>`,
  ].join('\n');
  const html = emailLayout({
    preheader: 'Here is the setup guide and how to get started.',
    heading: 'You\u2019re on the Quarterback beta list',
    bodyHtml,
    footerHtml: 'You received this because you asked for early access to Quarterback. Reply \u201cunsubscribe\u201d and we\u2019ll remove you.',
    site: SITE,
  });
  const text = [
    'You\u2019re on the Quarterback beta list',
    '',
    'Thanks for signing up to try Quarterback. It runs Claude Code against a requirements list you approve, checks the change with your tests and the agreed checks, and gives you the evidence and a patch to review. You decide whether to apply it.',
    '',
    `Setup guide: ${SETUP_GUIDE}`,
    '',
    'How to get started',
    ...steps.map((s, i) => `${i + 1}. ${stepText(s)}`),
    '',
    'Supported today: Claude Code on JavaScript or Node.js projects tested with node:test. The validated setup is Ubuntu 24.04 with Docker and 16 GB of RAM. macOS: limited successful runs; not a validated supported environment. You also need a Claude subscription or an API key.',
    '',
    'Quarterback is pre-release, and main changes as we fix things. If a step doesn\u2019t match what you see, reply with the step number and the output and we\u2019ll help.',
    '',
    `How it works: ${SITE}`,
    `Privacy: ${SITE}/privacy.html`,
    '',
    'Arshad, Velora',
    '',
    '--',
    'You received this because you asked for early access to Quarterback. Reply "unsubscribe" and we\u2019ll remove you.',
  ].join('\n');
  return { subject: 'You\u2019re on the Quarterback beta list: your setup guide', html, text };
}

async function sendWelcome(env, to, idempotencyKey) {
  const m = welcomeEmail(env);
  return sendMail(env, { to, ...m, idempotencyKey });
}

async function sendTelemetryLink(env, to, link) {
  const SITE = siteUrl(env);
  const html = emailLayout({
    preheader: 'Your one-time link expires in 30 minutes.',
    heading: 'Your Quarterback telemetry link',
    bodyHtml: [
      P('Someone asked for a Quarterback telemetry token for this email address. If it was you, open the link below within 30 minutes. It works once and shows your token once.'),
      button(link, 'Get my telemetry token'),
      P(`<span style="font-size:13px;color:${BRAND.muted};word-break:break-all;">Or paste this address into your browser: ${escHtml(link)}</span>`),
      P('If you didn’t ask for this, ignore this email. Nothing is turned on without the link.'),
    ].join('\n'),
    footerHtml: 'You received this because a telemetry token was requested for this address.',
    site: SITE,
  });
  const text = `Someone asked for a Quarterback telemetry token for this email address. If it was you, open this link within 30 minutes. It works once and shows your token once:\n\n${link}\n\nIf you didn’t ask for this, ignore this email. Nothing is turned on without the link.`;
  return sendMail(env, { to, subject: 'Your Quarterback telemetry link', html, text });
}

async function sendOwnerNotify(env, email, agent, count, ip, referrer, idempotencyKey) {
  const now  = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const rowsData = [['Email', email], ['Agent', agent || 'not specified'], ['Time', now], ['IP', ip || 'unknown'], ['Referrer', referrer || 'direct']];
  const rowsHtml = rowsData.map(([k, v], i) => `        <tr><td style="padding:9px 0;${i < rowsData.length - 1 ? `border-bottom:1px solid ${BRAND.line};` : ''}color:${BRAND.muted};width:90px;">${k}</td><td style="padding:9px 0;${i < rowsData.length - 1 ? `border-bottom:1px solid ${BRAND.line};` : ''}color:${BRAND.ink};">${escHtml(v)}</td></tr>`).join('\n');
  const html = emailLayout({
    preheader: `${email} asked for beta access (signup #${count}).`,
    heading: `New beta signup #${count}`,
    bodyHtml: `      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;border-collapse:collapse;margin:0 0 16px 0;">
${rowsHtml}
      </table>
${P(`<strong style="color:${BRAND.ink};">${count}</strong> total signups.`)}`,
    footerHtml: 'Owner notification from the Quarterback signup form.',
    site: siteUrl(env),
  });
  const text = rowsData.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nTotal signups: ${count}`;
  return sendMail(env, { to: OWNER, subject: `QB beta signup #${count}: ${email} (${agent || 'no agent'})`, html, text, idempotencyKey });
}

/**
 * The one way email leaves the worker. EMAIL_MODE (default 'live'):
 *   'test' — never sends, except to EMAIL_ALLOWLIST; returns { ok, simulated } (staging);
 *   anything else unknown — sends nothing and reports a configuration error (fails closed).
 * EMAIL_PROVIDER (default 'resend'): 'gmail' sends from the owner's Gmail account through the
 * Gmail API; any other value sends nothing (configuration error).
 */
async function sendMail(env, msg) {
  const mode = (env.EMAIL_MODE || 'live').trim();
  if (mode === 'test') {
    const allow = String(env.EMAIL_ALLOWLIST || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!allow.includes(String(msg.to).toLowerCase())) return { ok: true, simulated: true };
  } else if (mode !== 'live') {
    return { ok: false, config: true, error: `unknown EMAIL_MODE ${JSON.stringify(mode).slice(0, 40)}: nothing sent` };
  }
  const provider = (env.EMAIL_PROVIDER || 'resend').trim();
  if (provider === 'gmail') return gmailSend(env, msg);
  if (provider === 'resend') return resendSend(msg, env.RESEND_API_KEY);
  return { ok: false, config: true, error: `unknown EMAIL_PROVIDER ${JSON.stringify(provider).slice(0, 40)}: nothing sent` };
}

/**
 * One send. Returns { ok, error?, config? } — never throws. The idempotency key stops a retried
 * send from duplicating. config: true marks errors that repeat until the configuration changes
 * (no key; the provider refusing the key or the sender: 401/403).
 */
async function resendSend({ to, subject, html, text, idempotencyKey }, apiKey) {
  if (!apiKey) return { ok: false, config: true, error: 'RESEND_API_KEY not configured' };
  try {
    const res = await fetch(RESEND_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body:    JSON.stringify({ from: FROM, to, subject, html, ...(text ? { text } : {}) }),
    });
    if (res.ok) return { ok: true };
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* none */ }
    return { ok: false, config: res.status === 401 || res.status === 403, error: `provider HTTP ${res.status} ${detail}`.trim() };
  } catch (e) { return { ok: false, error: `network: ${e && e.message || e}` }; }
}

// ─── Gmail API (no domain needed: mail is sent from the owner's own Gmail account) ─────────────
//
// Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (scope gmail.send only),
// created once by tools/gmail-oauth/setup.js. Var GMAIL_SENDER (default OWNER) is the From address
// and must be the account that granted the token. Gmail has no idempotency key, so a stable
// Message-ID derived from the delivery key lets the recipient's mailbox collapse a duplicate.

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
let gmailToken = null; // { value, expires, id } cached per isolate

async function gmailAccessToken(env) {
  const id = env.GMAIL_CLIENT_ID, secret = env.GMAIL_CLIENT_SECRET, refresh = env.GMAIL_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return { config: true, error: 'Gmail API not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)' };
  if (gmailToken && gmailToken.id === id && gmailToken.expires > Date.now() + 60000) return { token: gmailToken.value };
  let res;
  try {
    res = await fetch(GMAIL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
    });
  } catch (e) { return { error: `network (token): ${e && e.message || e}` }; }
  let data = {}; try { data = await res.json(); } catch { /* none */ }
  if (res.ok && data.access_token) {
    gmailToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000, id };
    return { token: data.access_token };
  }
  // invalid_grant (revoked or expired refresh token) and invalid_client repeat until repaired
  const code = String(data.error || '').slice(0, 40);
  const config = res.status === 400 || res.status === 401 || /invalid_(grant|client)|unauthorized_client/.test(code);
  return { config, error: `Gmail token HTTP ${res.status} ${code}`.trim() };
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const utf8 = (s) => new TextEncoder().encode(s);
const b64url = (s) => b64(utf8(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
// RFC 2047 for headers; header values never carry CR/LF (no header injection)
const hdr = (s) => String(s).replace(/[\r\n]+/g, ' ');
const encWord = (s) => (/^[\x20-\x7E]*$/.test(s) ? hdr(s) : `=?UTF-8?B?${b64(utf8(hdr(s)))}?=`);

async function buildMime({ from, fromName, to, replyTo, subject, html, text, idempotencyKey }) {
  const boundary = `qb_${randomHex(12)}`;
  const domain = String(from).split('@')[1] || 'gmail.com';
  const id = idempotencyKey ? (await sha256Hex(`qb-msg:${idempotencyKey}`)).slice(0, 32) : randomHex(16);
  return [
    `From: ${encWord(fromName)} <${hdr(from)}>`,
    `To: ${hdr(to)}`,
    `Reply-To: ${hdr(replyTo || from)}`,
    `Subject: ${encWord(subject)}`,
    `Message-ID: <${id}@${domain}>`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    `List-Unsubscribe: <mailto:${hdr(replyTo || from)}?subject=unsubscribe>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(utf8(text || html.replace(/<[^>]+>/g, ' ')))),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(utf8(html))),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function gmailSend(env, msg) {
  const tok = await gmailAccessToken(env);
  if (!tok.token) return { ok: false, config: Boolean(tok.config), error: tok.error };
  const from = (env.GMAIL_SENDER || OWNER).trim();
  const raw = b64url(await buildMime({ ...msg, from, fromName: 'Quarterback by Velora', replyTo: from }));
  let res;
  try {
    res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tok.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  } catch (e) { return { ok: false, error: `network: ${e && e.message || e}` }; }
  if (res.ok) return { ok: true };
  let detail = ''; try { detail = (await res.text()).slice(0, 300); } catch { /* none */ }
  if (res.status === 401) gmailToken = null; // a stale cached token: retry with a fresh one
  // 403 is a configuration error (API disabled, scope missing) unless it is a quota limit
  const quota = /rateLimit|dailyLimit|quota|userRateLimitExceeded/i.test(detail);
  const config = res.status === 403 && !quota;
  return { ok: false, config, error: `Gmail HTTP ${res.status} ${detail.replace(/\s+/g, ' ').slice(0, 200)}`.trim() };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A preflight answer. It grants nothing by itself: withCors() adds a grant on the signup route only. */
function cors204() {
  return new Response(null, { status: 204 });
}

/** Grant CORS on a signup response only when the request's Origin is in ALLOWED_ORIGINS. */
function withCors(request, env, res) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return res;
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
