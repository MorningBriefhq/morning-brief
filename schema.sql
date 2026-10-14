-- Morning Brief — D1 schema (ARCHITECTURE.md contract).
-- Apply: wrangler d1 execute morning-briefing --file=schema.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- crypto.randomUUID()
  email TEXT UNIQUE NOT NULL,      -- lowercase, trimmed
  first_name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  theme TEXT NOT NULL DEFAULT 'light',  -- 'light' | 'dark' (validated by API)
  created_at INTEGER NOT NULL      -- unix seconds
);
CREATE TABLE magic_tokens (
  token TEXT PRIMARY KEY,         -- 32+ random bytes, hex
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,    -- unix seconds, 15 min TTL
  used_at INTEGER                  -- set on verify (single use)
);
CREATE TABLE user_tickers (
  user_id TEXT NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,           -- uppercase, validated against data/sp500.json
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ticker)
);
