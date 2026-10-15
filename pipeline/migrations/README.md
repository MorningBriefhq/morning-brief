# Morning Brief — D1 migrations

There is no automatic migration runner. Schema changes ship as numbered,
apply-once SQL files in this directory and are applied manually:

```bash
wrangler d1 execute morning-briefing --file=pipeline/migrations/NNNN-name.sql
```

## Conventions

- Numbered sequentially (`0002-…`, `0003-…`, …). `schema.sql` and
  `pipeline/schema-additions.sql` are the unnumbered predecessors — treat them
  as 0000/0001, already applied to production.
- **Apply once.** D1 has no `ADD COLUMN IF NOT EXISTS`; re-running a migration
  that contains `ALTER TABLE … ADD COLUMN` will error. The file header states
  the exact apply command.
- Additive only: never rename/drop columns in a migration. Old code must keep
  working after the migration is applied (deploy the schema change first, then
  the code that uses it).
- Keep `pipeline/local-run.js` and `pipeline/test.js` applying every file in
  this directory (in name order) after `schema-additions.sql`, so local dev
  always matches the post-migration production schema.

## Applied to production

| # | File | Applied |
|---|------|---------|
| 0002 | 0002-email-sends-claim.sql | _pending — apply before deploying the send-claim fix_ |
| 0003 | 0003-suppressions.sql | _pending — apply before deploying the Resend webhook / suppression check_ |
