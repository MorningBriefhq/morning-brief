# Morning Brief Pipeline — Data Improvement Research

**Date:** 2026-10-14
**Status:** Research only. No code changes. No merges. No deploys.

Pat's bar: "Useful information, no bullshit. Packed." Our-voice synthesis from pooled
sources, never regurgitation. Real data or nothing — a data gap is a data problem
(add sources, never approximate). US focus, S&P 500 scope. No ETF proxies for
index/futures values. "Stocks to Watch" = corporate news only.

**Current stack:** Marketaux, Guardian, FMP, Nasdaq, Alpaca, Finnhub, FRED.
Alpha Vantage key outstanding (never wired).

---

## 1. News APIs — more and better sources

### What's wired now
- **Marketaux** (primary for ticker news) — free tier ~100 req/day, **3 articles per
  request**. Has per-entity sentiment scores (-1..+1) and relevance scores. Good for
  ticker-tagged financial news. Paid tiers exist but pricing is not published on the
  site — contact sales.
- **Guardian Open Platform** (full-text) — free, 5,000 req/day, 12 req/sec.
  Non-commercial. Now pinned to US edition (`production-office=US`). Quality writing
  but general news, not financial-first.
- **Finnhub** `/news?category=general` — free tier. Headlines + summaries, no full
  text. Source quality varies.

### Candidates to add

**GDELT DOC 2.0** — https://www.gdeltproject.org/
- Free, no key, no signup. Global news firehose with tone scoring (-100..+100).
- Headlines + URLs only, **no body text**. Rate limit ~1 req/5 sec per IP.
- Best use: breadth/coverage check — "is this story getting global pickup?" and
  tone signal. Not a primary content source.
- Cost: $0. Verdict: **add as a supplementary signal**, not a content source.

**Tiingo News** — https://www.tiingo.com/
- Free tier: 20-50 req/hr, 1,000 req/day, 500 symbols/month. News endpoint supports
  ticker filtering, tags, sources, date ranges.
- Financial-news focused, cleaner than GDELT. Power tier ~$10-30/mo lifts caps.
- **Licensing catch:** free tier is "Internal Use Only" — no displaying data to
  end users. Paid commercial use from ~$50/mo.
- Cost: $0 (internal) / ~$50/mo (commercial display). Verdict: **worth testing**,
  but the display license is a real cost to factor.

**Alpha Vantage NEWS_SENTIMENT** — https://www.alphavantage.co/documentation/
- Ticker-tagged news with sentiment scores, premier outlets, real-time.
- **Free tier: 25 req/day** — too tight for a daily pipeline that needs multiple
  calls. Premium from **$49.99/mo** (75 req/min).
- The Alpha Vantage key is outstanding anyway — wiring it unlocks this plus
  INDEX_DATA, EARNINGS_CALENDAR, and Treasury/macro series (see below).
- Cost: $49.99/mo. Verdict: **wire the key first, evaluate NEWS_SENTIMENT on the
  paid tier only if free sources prove insufficient.**

**Polygon.io (now Massive) news** — https://polygon.io/docs/rest/stocks/news
- Ticker-tagged articles, good API. Stocks Starter $29/mo (delayed), Developer
  $79/mo, Advanced $199/mo (real-time).
- **Commercial licensing trap:** individual plans are non-professional use only.
  Business display starts at **$2,499/mo**. 12.5x jump. Do not build on individual
  tier if Morning Brief will ever charge.
- Verdict: **skip for news** — licensing cliff is too steep.

**Benzinga news API** — https://www.benzinga.com/apis/
- Institutional-grade, real-time, analyst ratings + news. Powers many brokerages.
- Pricing is enterprise/custom — no self-serve tier. Expect $500+/mo minimum.
- Verdict: **skip for now** — overkill at current scale. Revisit if/when revenue
  justifies it. (Benzinga Pro at $197/mo is a *terminal*, not an API.)

**Perigon** — https://www.perigon.io/ — $250/mo entry, entity enrichment, story
clustering. Good but pricey. Verdict: **skip**.

**NewsAPI.org** — $449/mo business tier, 24h delay on free. Verdict: **skip**.

### Recommendation (news)
1. **Quick win:** Add GDELT as a supplementary breadth/tone signal ($0).
2. **Quick win:** Wire the outstanding **Alpha Vantage** key — unlocks
   NEWS_SENTIMENT evaluation + index data + earnings calendar (see §2, §3).
3. **Evaluate:** Tiingo news on free tier for internal testing; budget ~$50/mo if
   the quality justifies commercial display.
4. **Skip:** Benzinga, Polygon news, Perigon, NewsAPI — cost or licensing cliffs.

---

## 2. Market data — kill the ETF proxies

### The problem
`beforeBell()` currently quotes **SPY, QQQ, DIA** as stand-ins for S&P 500,
Nasdaq 100, and Dow. Pat's rule: no ETF proxies. We need real index values and
real futures (ES, NQ).

### Real index values — options

| Source | Symbols | Cost | Notes |
|--------|---------|------|-------|
| **Finnhub** (already wired) | `^GSPC`, `^IXIC`, `^DJI`, `^VIX` via `/quote` | $0 | Free tier supports index quotes. **Try this first** — may already work with the existing key. |
| **Alpha Vantage INDEX_DATA** | S&P 500, Nasdaq, Dow, VIX | $0 (25/day) / $49.99/mo | 25/day is enough for 1 edition/day (4 calls). |
| **Stooq free CSV** | `^SPX`, `^NDQ`, `^DJI` | $0, no key | `https://stooq.com/q/l/?s=^SPX&f=sd2t2ohlcv&h&e=csv`. Unofficial but stable for years. Good fallback. |
| **Twelve Data** | Indices | $0 (800/day) | 8 credits/min free. Clean API. |
| **FMP** (already wired) | `^GSPC` etc. via quote | $0–$19/mo | Already have the key; check index quote support. |

**Recommendation:** Try Finnhub `^GSPC`/`^IXIC`/`^DJI`/`^VIX` first (zero new
dependencies). Fall back to Stooq CSV (zero cost, zero key). Wire Alpha Vantage
as the clean long-term path.

### Futures (ES, NQ) — the hard one
Real futures quotes are exchange-licensed and expensive everywhere. Options:
- **Stooq:** `ES.F`, `NQ.F` symbols sometimes available on free CSV. Worth testing.
- **Yahoo Finance** (`ES=F`, `NQ=F`): unofficial JSON API, no key, but rate-limits
  aggressively from datacenter IPs. Fragile.
- **Barchart OnDemand:** has futures quotes API, custom pricing (expect $$$$).
- **CME direct:** enterprise licensing, out of scope.

**Honest assessment:** Free real-time futures is a gap across the entire retail
API market. Best realistic path: Stooq `ES.F`/`NQ.F` if available, else Yahoo
with caching and fallback. If both fail, **show index values only** — do not
approximate futures from ETFs (that recreates the proxy problem).

### 10-year yield, oil, gold, VIX
- **FRED** (already wired): DGS10 (10-year), DGS2, CPI, unemployment — free,
  authoritative, but **1-day lag**. Fine for a morning brief.
- **Finnhub:** `/quote` for `^TNX` (10-yr), `USO`/`CL` proxies for oil, `GLD`
  proxy for gold, `^VIX`. Free tier.
- **Alpha Vantage:** commodities + Treasury yield endpoints.

**Recommendation:** FRED for authoritative (lagged) macro; Finnhub `^TNX`/`^VIX`
for current. Don't over-engineer — one source per metric, clearly labeled.

### Single-source option?
No single free/cheap source covers indices + futures + yields + commodities
reliably. **FMP** comes closest on paid ($19-49/mo) but futures are still thin.
Stick with the best-of-breed mix: Finnhub (quotes) + FRED (macro) + Stooq
(fallback).

---

## 3. Earnings & economic calendar

### Earnings calendar
Finnhub `/calendar/earnings` returned empty on 2026-10-14 (JPM reported that day
— data should exist). Possible causes: key permissions, date-boundary issue, or
upstream gap. Needs live debugging.

Alternatives, ranked:
1. **FMP earnings calendar** (`/earning_calendar?from=&to=`) — already wired,
   clean JSON, supports `includeReportTimes`. **Try this first.**
2. **Alpha Vantage EARNINGS_CALENDAR** — free tier, simple CSV/JSON. Good backup.
3. **Nasdaq API** — unofficial but historically reliable for US earnings.
4. **yfinance** `get_earnings_dates()` — free, no key, but rate-limit sensitive
   and unofficial. Last resort.

**Recommendation:** Debug Finnhub first (may be a one-line fix). Add FMP as
primary fallback — it's already wired and the endpoint is well-documented.

### Economic calendar (FOMC, CPI, NFP, PPI, GDP)
- **FXMacroData** — `https://api.fxmacrodata.com/v1/calendar/USD` — **free, no
  key, no signup** for USD. Includes event, impact, forecast, previous, source
  URLs (BLS, Fed). This is the standout option.
- **FRED release API** — already have the key. Release IDs for CPI (10), NFP
  (50), PCE (54). Authoritative dates.
- **Finnhub** `/calendar/econ` — already wired, returned empty same as earnings.
  Same debugging needed.

**Recommendation:** Add **FXMacroData** ($0, no key) as the primary econ
calendar. Use FRED release dates as the authoritative backup. Debug Finnhub's
empty response in parallel.

---

## 4. Better summaries

### Current state
`WorkersAISummarizer` defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
(70B) — already a large model, not the 8B assumed. Extractive fallback added
today for AI failures.

### Is the model enough?
70B is sufficient for financial summarization. The bottleneck is almost certainly
**prompting and input quality**, not model size. Larger models won't fix empty
inputs or bad prompts.

### What to actually fix (in priority order)
1. **Cross-source synthesis prompt.** Current code summarizes per-ticker from
   pooled articles, but the prompt should explicitly instruct: "Synthesize across
   these sources into our voice. Do not repeat any single source's framing.
   Lead with what happened, then why it matters."
2. **Input quality.** Summaries are only as good as `fullText`. The article
   scraper (`article.js`) is the weak link — if it returns junk, the LLM gets
   junk. Consider preferring Marketaux `description`/`snippet` + Guardian
   `bodyText` (structured, reliable) over scraped HTML.
3. **Story-level vs ticker-level.** For top_news, synthesize the *event* across
   all sources covering it (dedupe cluster → one our-voice summary), not one
   summary per article. This is the "pooled sources" requirement made concrete.
4. **Model alternatives on Workers AI** (if 70B underperforms):
   - `@cf/mistralai/mistral-small-3.1-24b-instruct` — 24B, strong instruction
     following, cheaper/faster.
   - `@cf/google/gemma-3-12b-it` — 128K context, good for long articles.
   - Test with real outputs, not benchmarks.

### Verdict
Don't chase bigger models. Fix the prompt (cross-source synthesis instruction),
fix the inputs (prefer structured API text over scraping), and synthesize at
the *event* level for top stories. Model is fine.

---

## 5. Analyst actions

FMP grades API returned nothing on 2026-10-14. The pipeline also has a
keyword-based fallback scanning Finnhub headlines for upgrade/downgrade
language, filtered by a firm allowlist.

Options ranked:
1. **FMP `/upgrades-downgrades`** (already wired) — debug why empty. May be a
   date-format or plan-tier issue.
2. **Benzinga analyst ratings API** — the gold standard, but enterprise pricing.
   Skip until revenue justifies.
3. **Marketaux** — some analyst-action coverage via financial news feed; already
   wired, no extra cost. Lean on it more.
4. **Finnhub `/analyst-recommendations`** — consensus data (buy/hold/sell counts),
   not individual actions. Useful for context, not for "who upgraded today."

**Recommendation:** Debug FMP first. Supplement with Marketaux keyword scan
(already have the feed). Benzinga only when the product earns it.

---

## 6. Stocks to Watch — surfacing corporate actions

Pat's rule: "what companies did/said/announced — not analyst reactions or
beat/miss filler." Categories: earnings, guidance, M&A, product launches,
leadership changes, buybacks, dividends.

### How to get this reliably
1. **Finnhub `/company-news`** per S&P 500 ticker + keyword classifier
   (already partially built — `MA_KEYWORDS`/`ANALYST_KEYWORDS` patterns exist).
   Extend with corporate-action patterns: `appoints`, `names.*ceo`, `launches`,
   `unveils`, `recalls`, `settlement`, `spinoff`, `buyback`, `raises dividend`.
2. **SEC EDGAR 8-K filings** — free, no key, authoritative. 8-Ks *are*
   "what companies announced." Items 1.01 (material agreements), 2.02 (earnings),
   5.02 (leadership changes), 8.01 (other events) map directly to Stocks to
   Watch categories. Poll the EDGAR full-text search or company filing feeds for
   S&P 500 CIKs. **This is the highest-signal, lowest-cost source nobody is
   using.**
3. **Marketaux entities** — already returns per-ticker tagged news; filter by
   relevance score and exclude analyst-firm sources.
4. **Benzinga** (future) — has explicit corporate-action categorization, but
   enterprise cost.

**Recommendation:** Add **SEC EDGAR 8-K** as a primary Stocks-to-Watch source
($0, authoritative, exactly matches Pat's definition). Extend the keyword
classifier for Finnhub/Marketaux. This is the biggest editorial upgrade
available for zero dollars.

---

## 7. Cost at scale

Key insight: **API cost is per-edition, not per-subscriber.** One pipeline run
per day = fixed API cost whether we have 1 subscriber or 1,000. Subscriber
growth hits Resend (email) cost, not data API cost.

### Estimated monthly API cost at 1 edition/day

| API | Tier | $/mo | Notes |
|-----|------|------|-------|
| Finnhub | existing | $0 | Free tier; check rate limits |
| FMP | Starter–Premium | $19–49 | Already wired |
| Marketaux | free | $0 | 100 req/day is plenty for 1 run |
| Guardian | free | $0 | 5,000/day, non-commercial |
| FRED | free | $0 | No limits that matter |
| Alpaca | free | $0 | Market data basic |
| Nasdaq | unofficial | $0 | Fragile, use sparingly |
| GDELT | free | $0 | Proposed addition |
| FXMacroData | free | $0 | Proposed addition |
| SEC EDGAR | free | $0 | Proposed addition |
| Stooq | free | $0 | Proposed fallback |
| Tiingo | free→Power | $0–30 | Evaluate; commercial display ~$50 |
| Alpha Vantage | Premium | $49.99 | Key outstanding; unlocks 4+ endpoints |
| **Total (recommended)** | | **~$70–130/mo** | |

### Traps to avoid
- **Polygon/Massive:** $199/mo individual → $2,499/mo business. 12.5x cliff.
  Do not build on it.
- **Benzinga:** enterprise-only API pricing. No self-serve.
- **Alpha Vantage:** commercial redistribution needs separate licensing even on
  paid tiers. Read the terms before displaying data to subscribers.
- **Tiingo:** free tier is internal-use-only. Commercial display costs extra.
- **Per-call pricing:** none of the recommended APIs are per-call metered at
  our volume. The risk is *tier jumps*, not usage spikes.

### At 1,000 subscribers
Data API cost: **unchanged** (~$70–130/mo). Email via Resend becomes the
dominant cost — separate analysis needed, but not a data-pipeline problem.

---

## Prioritized action list

### Quick wins (this week, minimal cost)
1. **Wire the Alpha Vantage key** — unlocks INDEX_DATA (kill ETF proxies),
   EARNINGS_CALENDAR, NEWS_SENTIMENT eval, Treasury/macro series. $0–49.99/mo.
2. **Add FXMacroData econ calendar** — free, no key, one endpoint.
3. **Add SEC EDGAR 8-K feed** for Stocks to Watch — free, highest editorial
   signal per dollar.
4. **Try Finnhub `^GSPC`/`^IXIC`/`^DJI`/`^VIX`** — may already work with existing
   key. Zero new dependencies.
5. **Add GDELT** as breadth/tone signal — free, one throttled call.
6. **Debug Finnhub calendar emptiness** — may be a one-line fix, unblocks
   earnings + econ.

### Bigger investments (after tomorrow's edition review)
7. **Rewrite the synthesis prompt** for cross-source our-voice output; synthesize
   at event level for top stories.
8. **Prefer structured API text** (Marketaux snippet, Guardian bodyText) over
   HTML scraping for LLM inputs.
9. **Evaluate Tiingo news** on free tier; budget ~$50/mo if quality justifies it.
10. **Stooq CSV** as universal fallback for quotes (indices, futures, FX).

### Do not pursue
- Polygon/Massive (licensing cliff), Benzinga API (enterprise cost),
  Perigon ($250/mo), NewsAPI.org ($449/mo), bigger LLM (70B is enough —
  fix prompts and inputs first).

---

*Research by Web Team, 2026-10-14. No code changed. Awaiting Pat's review of
tomorrow's edition before implementation.*
