-- Morning Brief — migration 0003: bounce/complaint suppression table.
--
-- The Resend webhook at functions/api/webhooks/resend.js writes here on
-- email.bounced and email.complained events (Svix-signature verified).
-- The assemble stage excludes these addresses from every send — this table
-- is the single source of truth for "never mail this address again".
--
-- Apply ONCE to production D1:
--   wrangler d1 execute morning-briefing --file=pipeline/migrations/0003-suppressions.sql
--
-- CREATE TABLE IF NOT EXISTS makes this re-runnable (unlike ADD COLUMN
-- migrations). Purely additive — safe to apply before deploying the code
-- that reads it.

CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,          -- lowercase, trimmed
  reason TEXT NOT NULL,            -- 'bounce' (may include the mail-server message) | 'complaint'
  created_at INTEGER NOT NULL      -- unix seconds
);
