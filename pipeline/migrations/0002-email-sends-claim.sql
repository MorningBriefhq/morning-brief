-- Morning Brief — migration 0002: crash-safe send claims.
--
-- Adds claim-lease columns to email_sends so a worker crash between the
-- Resend API call and the 'sent' UPDATE can't strand a user in 'sending'
-- forever (previously the next tick's INSERT OR IGNORE skipped them and
-- they never got the brief). See pipeline/stages.js runAssemble.
--
--   resend_id  — Resend message id, stored on successful send (audit/de-dupe).
--   claimed_at — unix seconds when the row was claimed (or re-claimed).
--                Rows stuck at 'sending' with a lease older than 30 min
--                (or NULL, for rows written before this migration) are
--                re-claimed and retried at the start of each assemble run.
--
-- Apply ONCE to production D1 (D1 has no ADD COLUMN IF NOT EXISTS):
--   wrangler d1 execute morning-briefing --file=pipeline/migrations/0002-email-sends-claim.sql
--
-- Ordering: apply this BEFORE deploying any worker build that references
-- these columns. The migration is purely additive, so applying it early is
-- safe for the currently deployed code (old code ignores the new columns).

ALTER TABLE email_sends ADD COLUMN resend_id TEXT;
ALTER TABLE email_sends ADD COLUMN claimed_at INTEGER;
