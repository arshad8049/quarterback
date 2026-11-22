-- Signup delivery hardening (2026-11-07): a delivery may stop at 'blocked_config' when the email
-- configuration is wrong (no API key, provider 401/403). The cron does not retry it; it is
-- re-queued after the repair (docs/website/signup.md).
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with the same
-- columns, data and index. Apply BEFORE deploying the worker that writes 'blocked_config':
--   npx wrangler d1 execute <database> --remote --file=landing_page/migrations/0006_delivery_blocked_config.sql
-- D1 runs a --file as one transaction: either the whole rebuild applies or nothing does.

CREATE TABLE email_deliveries_0006 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT    NOT NULL UNIQUE,
  kind            TEXT    NOT NULL CHECK (kind IN ('welcome', 'owner_notify')),
  recipient       TEXT    NOT NULL,
  payload         TEXT    NOT NULL DEFAULT '{}',
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead', 'blocked_config')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT    NOT NULL,
  next_attempt_at TEXT    NOT NULL,
  claimed_at      TEXT,
  sent_at         TEXT
);

INSERT INTO email_deliveries_0006 (id, idempotency_key, kind, recipient, payload, status, attempts, last_error, created_at, next_attempt_at, claimed_at, sent_at)
  SELECT id, idempotency_key, kind, recipient, payload, status, attempts, last_error, created_at, next_attempt_at, claimed_at, sent_at
  FROM email_deliveries;

DROP TABLE email_deliveries;
ALTER TABLE email_deliveries_0006 RENAME TO email_deliveries;
CREATE INDEX IF NOT EXISTS idx_ed_status_next ON email_deliveries(status, next_attempt_at);
