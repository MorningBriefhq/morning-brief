-- Morning Brief — pipeline schema additions.
-- Apply ONCE, after schema.sql:
--   wrangler d1 execute morning-briefing --file=pipeline/schema-additions.sql
--
-- Existing tables (users, magic_tokens, user_tickers) are untouched.

-- Raw ingested articles per ticker per day (debugging / re-runs).
CREATE TABLE IF NOT EXISTS ticker_news_raw (
  run_date TEXT NOT NULL,          -- ET date "YYYY-MM-DD"
  ticker TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 0,
  articles_json TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (run_date, ticker)
);

-- One summary per ticker per day, shared across all users holding it.
CREATE TABLE IF NOT EXISTS ticker_summaries (
  run_date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  company TEXT NOT NULL,
  summary TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_date, ticker)
);

-- Market-overview sections per day: top_news, before_bell, calendar.
CREATE TABLE IF NOT EXISTS market_briefs (
  run_date TEXT NOT NULL,
  section TEXT NOT NULL,           -- top_news | before_bell | calendar
  payload TEXT NOT NULL,          -- JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_date, section)
);

-- Stage idempotency: one row per (run_date, stage).
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_date TEXT NOT NULL,
  stage TEXT NOT NULL,             -- ingest | summarize | market | assemble
  status TEXT NOT NULL,            -- started | done | failed
  detail TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (run_date, stage)
);

-- Cursor for chunked full-universe ingestion (id = 'ingest_offset:YYYY-MM-DD').
CREATE TABLE IF NOT EXISTS pipeline_progress (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-user send log; doubles as assemble idempotency.
CREATE TABLE IF NOT EXISTS email_sends (
  run_date TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,            -- sent | failed
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (run_date, user_id)
);

-- Unsubscribe flag. NOTE: D1 has no IF NOT EXISTS for ADD COLUMN — apply once.
ALTER TABLE users ADD COLUMN unsubscribed_at INTEGER;
