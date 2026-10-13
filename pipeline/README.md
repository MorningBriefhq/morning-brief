# Morning Briefing — overnight pipeline

Scheduled pipeline that produces and sends the personalized morning email.
See `ARCHITECTURE.md` (Pipeline section) for the contract.

## Layout

```
pipeline/
  worker.js            # Cloudflare Worker entry: scheduled() hourly tick, ET windows
  wrangler.toml        # Worker config (cron, D1 binding, env defaults)
  stages.js            # ingest / summarize / market / assemble (+ idempotent runStage)
  schema-additions.sql # pipeline tables + users.unsubscribed_at (apply ONCE, after schema.sql)
  sync-template.js     # regenerates email-template.js from email/template.html
  email-template.js    # bundled template copy (generated — do not edit by hand)
  local-run.js         # local end-to-end harness (mock mode, writes pipeline/outbox/)
  test.js              # unit + integration tests: node --test pipeline/test.js
  lib/
    time.js            # ET-anchored dates (run_date, windows) — DST-safe
    render.js          # {{placeholders}} + {{#each}} renderer (HTML-escaped)
    sign.js            # unsubscribe token HMAC (mirrors functions/api/_lib.js)
    news.js            # NewsProvider: Finnhub (real) / Mock
    summarize.js       # Summarizer: Anthropic (real) / Mock
    market.js          # MarketProvider: Mock (real feeds later)
    send.js            # Sender: Resend (real or log-stub) / FileOutbox
    mock-data.js       # canned articles + market sections for mock mode
```

## Quick start (mock mode, no keys, no Cloudflare)

```bash
cd ~/workspace/morning-briefing
node pipeline/local-run.js --date=2026-10-12        # held tickers
node pipeline/local-run.js --date=2026-10-12 --full # whole S&P 500 universe
node --test pipeline/test.js                        # 12 tests
```

`local-run.js` seeds 3 users (one unsubscribed), runs ingest → summarize →
market → assemble, writes rendered emails to `pipeline/outbox/`, then re-runs
summarize + assemble to prove idempotency.

## Schedule

Cloudflare cron `0 * * * *` (hourly tick). The worker checks the
America/New_York hour itself, so DST shifts are handled:

| ET window | Stage |
|---|---|
| 4:xx AM | ingest (overnight news) → summarize → market overview |
| 6:xx AM | assemble → send (emails land ~7 AM ET) |

Stages claim `(run_date, stage)` in `pipeline_runs` — re-runs and overlapping
ticks are safe no-ops.

## Env vars (all optional; mocks/stubs when unset)

| Var | Effect when set |
|---|---|
| `FINNHUB_API_KEY` | Real per-ticker news via Finnhub company-news (free tier: 60 calls/min) |
| `ANTHROPIC_API_KEY` | Real LLM summaries (2-3 sentences, news-only prompt) |
| `SUMMARIZER_MODEL` | Anthropic model id (default `claude-haiku-4-5`) |
| `RESEND_API_KEY` | Real email sending via Resend (else log-only stub) |
| `SESSION_SECRET` | **Required in prod.** Must match the Pages project's secret — it signs both session cookies and unsubscribe tokens |
| `PRODUCT_NAME` | Display name in subject lines (default "Morning Briefing") |
| `PUBLIC_ORIGIN` | Pages site origin for unsubscribe links |
| `BRIEFING_FROM` | From-address for sends |
| `INGEST_MODE` | `held` (default: only tickers users hold) or `full` (whole S&P 500, chunked) |
| `INGEST_CHUNK_SIZE` | tickers per tick in full mode (default 40) |

## Key behaviors

- **Quiet tickers are skipped silently** — only tickers with overnight news get summaries and appear in YOUR STOCKS.
- **Summaries are generated once per (run_date, ticker)** and shared across all users holding that ticker.
- **Freemium limit** is enforced at write time by `/api/tickers`; the pipeline simply reads what's stored.
- **Unsubscribed users** (`users.unsubscribed_at`) are excluded from sends and from ingest targeting. One-click link: `/api/unsubscribe?token=…`.
- **No real sending without `RESEND_API_KEY`.** No keys in code, ever.

## Cost estimate (at ~1,000 users)

| Item | Cost |
|---|---|
| Finnhub free tier | $0 (60 calls/min; ~500 company-news calls/day fits) |
| Summaries (Workers AI free tier, default) | $0 |
| Summaries (Anthropic Haiku fallback, ~50–150 tickers w/ news/day) | ~$0.15–0.45/day → ~$5–14/mo |
| Resend | free ≤100 emails/day; 1,000 users need the $20/mo plan |
| D1 / Workers / Pages | free tiers cover this workload |
| **Total at 1,000 users** | **~$25–35/mo** |
| At ≤100 users | ~$5–14/mo (Resend free tier) |

## Go-live checklist

1. `wrangler d1 execute morning-briefing --file=pipeline/schema-additions.sql` (after schema.sql)
2. `wrangler secret put SESSION_SECRET --config pipeline/wrangler.toml` (same value as Pages project)
3. `wrangler deploy --config pipeline/wrangler.toml`
4. Add `FINNHUB_API_KEY` when ready for real news
5. Add `ANTHROPIC_API_KEY` when ready for real summaries
6. Add `RESEND_API_KEY` + verify sending domain when ready for real mail
7. Rename: replace the product name (this default, `email/template.html`, `index.html`, `profile.html`) when Pat picks the final name
