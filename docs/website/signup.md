# Beta signup: input, abuse and delivery (QB-35)

**Problem (review, QB-35):**
- `null` or wrongly typed JSON threw before validation (`body.email` on `null`).
- There were no payload bounds and no rate limits.
- Deduplication was select-then-insert, so two concurrent submissions raced.
- Both emails were sent with `Promise.allSettled`, so a failure was silently dropped while the API reported success, and there was no retry.
- The legacy Pages function `functions/api/beta-access.js` had the same code.

## Input

`POST /api/beta-access` accepts a JSON object of at most **2 KiB** (else **413**) with only these fields; anything else is a defined **400**:

| Field | Rule |
|---|---|
| `email` | a string, trimmed and lower-cased, ≤ 254 characters, an address |
| `agent` | optional; a string of ≤ 80 printable characters, or null |

Unknown fields, `null`, arrays, numbers and unparsable bodies are all rejected.

## Abuse control

At most **10 attempts per IP per hour** (**429**). The limiter stores only `sha256("qb-signup:" + IP)` (`signup_attempts`). The `submissions` table still records the IP as before; QB-32 reviews that data flow.

## Atomic registration

`INSERT … ON CONFLICT(email) DO NOTHING`. Concurrent duplicates create exactly one row, and the others answer `{ ok, registered, duplicate: true }` with no email sent.

## Delivery, tracked separately

- **One queue row per email:** each signup queues one row per email in `email_deliveries`, keyed `welcome:<email>` and `owner-notify:<email>` (`UNIQUE`).
  - A send **claims** the row with a conditional update, so only one sender at a time.
  - Each send carries that key as Resend's `Idempotency-Key`.
  - The result is recorded: `sent`, or `failed` with `last_error` and exponential backoff.
  - After 6 attempts the row becomes `dead`.
- **The response says what happened:** `welcome_email: "sent"` or `"pending_retry"`. Registration success never depends on delivery.
- **Cron retry:** `wrangler.toml [triggers] crons = ["*/10 * * * *"]` runs `scheduled()`, which retries due `pending`/`failed` rows. A send stuck in `sending` for more than 10 minutes is retried, and Resend's idempotency key prevents a duplicate delivery.
- **Observable:** `GET /api/report` (admin) shows deliveries by status and the latest failures.

## Form

The landing-page form shows the server's actual outcome:
- registered, with the email either sent or "delayed and will be retried";
- "already on the list";
- invalid input;
- rate limited.

## Deploying

Apply **before** merging to `main`:

```
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0003_qb35_signup_delivery.sql
```

The cron trigger deploys with the worker.

## Tests

`test/unit/qb35-signup.test.js` runs the real worker on a real SQLite D1 (Node 22+; CI 22/24). It covers:
- defined responses for bad input;
- 4 concurrent duplicates → 1 row and 1 welcome email;
- a mocked provider failure → registered and `pending_retry`, with the failure visible; the cron retry delivers each email **once**; a re-signup changes nothing;
- dead after 6 attempts;
- an interrupted send is retried;
- the per-IP limit.

Pre-fix, all 5 fail, the first with `TypeError: Cannot read properties of null (reading 'email')`.

## Limits

With Resend, welcome emails can only reach the account owner until a verified sender domain replaces `onboarding@resend.dev`. With no domain, the Worker sends through the owner's Gmail account instead (see "Email via Gmail" below).

## Re-review 1: registration and delivery intents commit atomically

- **One transaction:** a signup runs ONE D1 batch (one transaction) holding the `submissions` insert (`ON CONFLICT DO NOTHING`) and **both** delivery intents (`ON CONFLICT(idempotency_key) DO NOTHING`). A database failure anywhere, before either enqueue or between the two, leaves **nothing**, and the client simply retries. Pre-fix, the registration survived without jobs, and the duplicate early-return meant they were never created.
- **Repair path:** the idempotent enqueues also run for duplicates, so a registration missing its jobs (made by an older worker, or by a crash) is repaired on the next signup attempt. Completed jobs are never re-sent: only `pending`/`failed` jobs are claimed.
- **Sends stay outside the transaction:** each job carries a stable payload and its idempotency key. The owner-notification count is computed at send time.
- **Legacy signups:** migration `0004` records them as closed (`dead`, with "legacy signup before delivery tracking; not re-sent"), so a returning legacy user doesn't get a second welcome email.
- **Regressions:** faults injected before either enqueue and between the two (no registration, then retry → each email once); legacy repair (one welcome, never repeated); concurrent duplicates with a transient enqueue failure (1 row, 1 welcome).

## Re-review 2: completion outlives retention

The senior's reproduction: register, let retention delete the sent delivery rows after 30 days, register again. The repair path recreated both jobs and sent a second welcome. The legacy markers from migration `0004` expired the same way.

- **Durable completion state:** `delivery_completions` (migration `0005`) holds one row per completed delivery: `sha256("qb-delivery:" + idempotency key)`, the outcome (`sent` or `dead`) and the time. It contains no address, payload or log.
  - It is written in the same transaction that marks a delivery `sent` or `dead`.
  - Retention records it, in the same transaction, before deleting each expired sent/dead row. That covers rows written before the table existed and the `0004` legacy markers, which SQL can't hash during the migration.
- **Never-enqueued vs completed:** the enqueue is `INSERT … SELECT … WHERE NOT EXISTS (completion)`. A completed or legacy-suppressed delivery is never queued again; a registration whose jobs were never enqueued has no completion, so it is still repaired.
- **Retention still deletes** the delivery rows (address, payload, error log) after 30 days.
- **Signup quota:** the IP limiter admits atomically (see `metrics-auth.md` § Re-review 2).
- **Regressions** (`test/unit/phase5-rereview2.test.js`):
  - retention then repeat signup → still one welcome and one owner notice (pre-fix: 2);
  - legacy markers expire, then a repeat signup → no welcome (pre-fix: 1);
  - a never-enqueued registration is still repaired after retention ran, while a completed one isn't re-sent;
  - completion rows contain no address.

## Hardening (2026-11-07): configuration errors, crashes after commit, staging

**Why:** production showed every welcome email retried six times and then `dead` with `provider HTTP 403 … You can only send testing emails to your own email address`. That error repeats until the sender domain is fixed, so retrying it only hides it.

- **`blocked_config`:** a send that fails because of configuration stops there and is **not retried by the cron**. That covers no `RESEND_API_KEY`, the provider answering 401/403, or an unknown `EMAIL_MODE`. It gets no completion record, so it can be re-queued. Transient errors (5xx, network) stay `failed` with backoff, as before. Migration `0006` allows the new status.
- **The response:** `welcome_email` is `sent`, `simulated` (staging), `not_sent` (blocked by configuration) or `pending_retry`. The form says each one plainly.
- **Nothing after the commit turns into an error:** the signup and both jobs commit in one batch, as before. Each job is then claimed and sent in its own `try`, so a database or provider error on one job neither fails the response nor stops the other job. The cron sends what was left pending, once.
- **Re-queue after a repair** (for example, after a sender domain is verified):

  ```
  npx wrangler d1 execute qb-beta --remote --command "UPDATE email_deliveries SET status = 'pending', next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'blocked_config'"
  ```

  The next cron run (within 10 minutes) sends each job once, with its idempotency key.
- **Staging** (`wrangler.toml [env.staging]`): the Worker `quarterback-staging` with the database `qb-beta-staging`, its own `ADMIN_SECRET` and its own cron.
  - `EMAIL_MODE = "test"` records deliveries as `sent` with `last_error = "simulated (EMAIL_MODE=test): not sent"` and never calls the provider, except for addresses in `EMAIL_ALLOWLIST` (empty by default).
  - `ALLOWED_ORIGINS = "https://arshad8049.github.io"`: only the preview may call its signup endpoint from a browser.
- **CORS:** only `POST /api/beta-access` can grant CORS, and only to an origin in `ALLOWED_ORIGINS`, echoed with `Vary: Origin`. Production leaves it unset, because the site's own form is same-origin. Before this change, every endpoint answered `Access-Control-Allow-Origin: *`. No endpoint other than the site form had a browser caller (inventory, 2026-11-07). CORS only limits browsers: validation, the 2 KiB size limit and the per-IP rate limit apply to every caller.
- **The form's endpoint:** chosen by the page's host, and it fails closed. The production and staging hosts post to themselves, `arshad8049.github.io` posts to staging, and any other host disables the form with a link to the live site.
- **Tests:** `test/unit/signup-delivery-config.test.js`:
  - provider 401/403 and no key → `blocked_config`, with no cron retry and a visible report;
  - re-queue → sent once;
  - 5xx stays retryable;
  - a crash after the commit → `registered` and sent once by the cron;
  - a crash before the commit → nothing saved, and the retry succeeds;
  - concurrent duplicates against a failing provider;
  - test mode, the allowlist, and an unknown mode failing closed;
  - `SITE_URL` in email links;
  - CORS by origin and by endpoint;
  - the 0006 table rebuild keeping every row.

## Email via Gmail (2026-11-07, owner decision: no domain)

Resend needs a verified domain to reach anyone but the account owner, and there is no domain. So the Worker can send from the owner's own Gmail account through the Gmail API: `EMAIL_PROVIDER = "gmail"`.

**How it sends:**
- It exchanges a refresh token for an access token, which is cached for about an hour.
- It then posts one MIME message to `gmail/v1/users/me/messages/send`. The message is `multipart/alternative` (plain text and HTML), from `Quarterback by Velora <GMAIL_SENDER>`, with `Reply-To` and `List-Unsubscribe` set to the same address.
- The OAuth scope is `gmail.send` only: the Worker can send mail as the owner but can't read the mailbox.

**Secrets** (never in the repository): `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. The var `GMAIL_SENDER` defaults to the owner's address.

**Errors:**

| What happened | Result |
|---|---|
| no credentials, a revoked or expired refresh token (`invalid_grant`), or a 403 such as the API being disabled | `blocked_config` (stopped; re-queue after the repair) |
| a 403 quota error, 429, 5xx or a network error | `failed` (retried with backoff) |
| a 401 on send | the cached token is dropped and the retry gets a new one |

**Duplicates:** Gmail has no idempotency key. Each delivery gets a stable `Message-ID` (a hash of its idempotency key), so a re-sent job collapses in the recipient's mailbox. The claim step still allows only one sender at a time.

**Limits:**
- A personal Gmail account sends about 500 messages a day.
- Mail comes from a `gmail.com` address, which suits a supervised beta.

### One-time setup (about 10 minutes)

1. In Google Cloud Console (console.cloud.google.com), signed in as the sending account:
   - create a project named `quarterback-mail`;
   - in **APIs & Services → Library**, enable the **Gmail API**.
2. In **OAuth consent screen** (Google Auth Platform):
   - User type **External**, app name `Quarterback`, support and contact email = the sending account.
   - Under **Audience**, click **Publish app**. While an app is in "Testing", refresh tokens expire after 7 days. A published app that isn't verified still works for its owner, after a one-time "unverified app" warning.
3. In **Credentials**, choose **Create credentials → OAuth client ID → Desktop app**, then **Download JSON**.
4. From the repository root, run:

   ```
   node tools/gmail-oauth/setup.js ~/Downloads/client_secret_*.json --env=both
   ```

   In the browser, choose the account, click **Advanced → Go to Quarterback (unsafe)** (the app is yours), then **Allow** (send email on your behalf). The script stores the three secrets on `quarterback` and `quarterback-staging`. It prints no secret and writes none to disk.
5. Set `EMAIL_PROVIDER = "gmail"` in `wrangler.toml` `[vars]` and deploy. Then re-queue the `blocked_config` jobs (command above).

**To revoke:** remove "Quarterback" at myaccount.google.com/permissions. Sends then stop at `blocked_config` (`invalid_grant`).

**Staging:** it keeps `EMAIL_MODE = "test"`, so it never calls Google, except for addresses in `EMAIL_ALLOWLIST`.

**Tests** (`test/unit/signup-gmail.test.js`):
- a send through the Gmail API with headers and both parts;
- the cached token;
- a stable Message-ID;
- missing credentials, `invalid_grant` and a non-quota 403 → `blocked_config`;
- 429, 5xx and a quota 403 retried;
- a 401 refreshes the token;
- CR/LF refused before saving;
- an unknown provider fails closed;
- staging never calls Google;
- the telemetry link appears in both parts.
