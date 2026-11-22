#!/usr/bin/env node
/**
 * One-time Gmail API setup for the signup Worker (docs/website/signup.md, "Email via Gmail").
 *
 *   node tools/gmail-oauth/setup.js <client_secret.json> [--env production|staging|both]
 *
 * <client_secret.json> is the "Desktop app" OAuth client downloaded from Google Cloud Console.
 * The script opens Google's consent page in your browser (scope: gmail.send only — it can send
 * mail as you, it cannot read your mailbox), receives the answer on 127.0.0.1, and stores
 * GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN as Worker secrets with
 * `wrangler secret put`. Nothing secret is printed or written to disk.
 */
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const envArg = (args.find((a) => a.startsWith('--env=')) || '--env=both').slice(6);
if (!file || !['production', 'staging', 'both'].includes(envArg)) {
  console.error('usage: node tools/gmail-oauth/setup.js <client_secret.json> [--env=production|staging|both]');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const c = cfg.installed || cfg.web;
if (!c || !c.client_id || !c.client_secret) { console.error('not an OAuth client JSON (expected "installed" with client_id and client_secret)'); process.exit(2); }

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(crypto.randomBytes(48));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const done = (msg, code = 0) => { res.writeHead(200, { 'Content-Type': 'text/plain' }).end(msg); server.close(); if (code) process.exitCode = code; };
  if (u.searchParams.get('state') !== state) return done('State mismatch; run the script again.', 1);
  if (u.searchParams.get('error')) return done(`Google returned: ${u.searchParams.get('error')}`, 1);
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: u.searchParams.get('code'), client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const tok = await r.json();
  if (!r.ok || !tok.refresh_token) return done(`Token exchange failed: HTTP ${r.status} ${tok.error || 'no refresh_token'}`, 1);
  if (!String(tok.scope || '').split(' ').includes(SCOPE)) return done('The gmail.send permission was not granted; run again and allow it.', 1);
  done('Done. You can close this tab and return to the terminal.');

  const targets = envArg === 'both' ? ['production', 'staging'] : [envArg];
  const secrets = { GMAIL_CLIENT_ID: c.client_id, GMAIL_CLIENT_SECRET: c.client_secret, GMAIL_REFRESH_TOKEN: tok.refresh_token };
  for (const t of targets) {
    for (const [name, value] of Object.entries(secrets)) {
      const argv = ['wrangler', 'secret', 'put', name, ...(t === 'staging' ? ['--env', 'staging'] : [])];
      const p = spawnSync('npx', argv, { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
      if (p.status !== 0) { console.error(`wrangler secret put ${name} (${t}) failed`); process.exit(1); }
      console.log(`stored ${name} on ${t}`);
    }
  }
  console.log('Gmail sending is configured. Next: set EMAIL_PROVIDER = "gmail" (docs/website/signup.md).');
});

server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  console.log('Opening Google consent in your browser. If it does not open, visit:\n' + url + '\n');
  try { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* printed above */ }
});
