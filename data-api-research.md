# Morning Brief — Market Data API Research

**Date:** 2026-10-12
**Question:** Which paid data APIs are worth buying for a daily personalized stock newsletter?
**User constraint:** "Quality and accuracy are important. We need solid information pipelines" + "reliable as well" — willing to pay.

---

## TL;DR — The Recommendation

**Buy exactly one thing: FMP Starter at $22/mo (billed annually, $264/yr).** It solves the #1 weak spot (Analyst Moves) with a real structured feed. Everything else stays on free tier.

| API | Verdict | Monthly cost |
|-----|---------|--------------|
| FMP Starter | **BUY** — fixes analyst ratings | $22 (annual) |
| Finnhub | Stay free — no affordable paid tier exists | $0 |
| Tiingo | Optional backup for news | $0–30 |
| Benzinga API | Skip — enterprise pricing, overkill | — |
| Massive (ex-Polygon) | Skip — real-time not needed for 7 AM email | — |

**Total new spend: $22/mo.**

---

## 1. FMP Paid Tiers — Analyst Ratings (HIGHEST ROI)

### What the free tier gives you now
- 250 calls/day, 10 results per API call
- Earnings calendar + econ calendar (already in use, working well)

### What Starter ($22/mo annual) unlocks
- **300 calls/min** (vs 250/day) — effectively unlimited for a daily batch
- **100 results per API call** (vs 10) — critical for scanning analyst activity
- Real-time US quotes
- Annual-only fundamentals

### The endpoint that matters: `stable/grades-latest-news`
FMP's own documentation identifies this as the primary endpoint for analyst monitoring:
- Consolidates **upgrades, downgrades, and reiterations** into a single response
- Returns: **grading company (firm), previous grade, new grade, action taken, timestamp, price target, news URL**
- This is EXACTLY what "Analyst Moves" needs — structured data with firm attribution, not headline scraping

FMP's education materials explicitly state: *"You can get a feel for this workflow on FMP's Free plan... If you want to screen more names on a daily basis, the Starter plan increases the cap to 100 results, making it practical to monitor broader coverage sets."*

### Supporting endpoints (also on Starter)
- `stable/grades-historical` — dated StrongBuy/Buy/Hold/Sell/StrongSell counts over time
- `v4/price-target` — individual analyst targets with publishedDate, priceTarget, priceWhenPosted
- `v4/upgrades-downgrades-consensus` — current consensus snapshot

### What Premium ($59/mo) and Ultimate ($149/mo) add
- Premium: quarterly/full fundamentals, 750 calls/min — **not needed** for a newsletter
- Ultimate: earnings call transcripts — **not needed** (summaries don't require transcripts)

### Verdict
**Starter is the sweet spot.** It transforms Analyst Moves from fragile headline-scraping into a reliable structured feed. The $22/mo is the single highest-ROI data spend available.

**Implementation note:** Replace the current `analysts()` method in `lib/market-finnhub.js` (which scrapes Finnhub news headlines for firm names) with FMP's `grades-latest-news` endpoint filtered to the last 24 hours. One API call per day covers all tickers.

---

## 2. Finnhub — Stay Free

### Free tier (current)
- 60 API calls/min — generous
- Real-time US quotes, company news, general news, earnings calendar
- 1 year historical data

### Paid tiers
- **There is no affordable paid step.** The All-In-One plan is **$3,500/mo** ($42,000/yr, annual-only).
- Per-market fundamental plans ($50–200/mo) exist but don't add what we need.

### Is free sufficient for a daily batch run?
**Yes.** A typical 4 AM ET run needs approximately:
- 10 tickers × 1 company-news call = 10 calls
- 8 market quotes (SPY, QQQ, DIA, TLT, USO, GLD, UUP, EFA) = 8 calls
- 1 general news call = 1 call
- 1 earnings calendar + 1 econ calendar = 2 calls (currently via FMP)
- **Total: ~21 calls** — well within 60/min free limit

Even at 1,000 users with 10 tickers each, the market-level calls (quotes, news, calendar) are shared. Only per-ticker news scales with users, and at 60/min that's 3,600 calls/hour of headroom.

### Verdict
**Stay on free tier indefinitely.** The $3,500/mo jump is designed for institutional redistribution, not a newsletter. If Finnhub ever degrades free-tier news quality, Tiingo (below) is the fallback.

---

## 3. Benzinga API — Skip

### What it offers
- Real-time news wire, analyst ratings with history back to 2012
- Structured upgrades/downgrades/price targets
- Delivered via Massive (Benzinga's API platform partner)
- Used by TradingView, Crypto.com, Perplexity

### Pricing
- **No public self-serve pricing.** Benzinga's API is enterprise-oriented (custom deals with brokerages and platforms).
- Benzinga Pro (the trader subscription) is $37–197/mo, but that's a human-facing product, not API access.
- Massive's own tiers (Starter $29/mo, Developer $79/mo, Advanced $199/mo) cover market data, not Benzinga's content feed.

### Verdict
**Skip.** The data quality is excellent, but without transparent pricing it's likely $500+/mo minimum for API access. FMP Starter at $22/mo solves the same analyst-ratings problem at 1/20th the cost. Revisit only if Morning Brief reaches 10,000+ paying subscribers and needs Benzinga's speed edge.

---

## 4. Massive (formerly Polygon.io) — Skip

### Pricing
- Starter: $29/mo (15-min delayed, unlimited calls)
- Developer: $79/mo (delayed)
- Advanced: $199/mo (real-time)

### Verdict
**Skip.** A 7 AM ET email doesn't need real-time data. Finnhub free already provides real-time US quotes at no cost. Massive only makes sense for live trading applications, not a daily digest.

---

## 5. News API Alternatives — Finnhub Is Good Enough

### Current: Finnhub news
- `/news?category=general` for Top News
- `/company-news` per ticker for Your Stocks
- Strength: integrates with market data, good for signal-driven workflows
- Weakness: not as broad as dedicated news aggregators

### Alternative: Tiingo News
- 70M+ articles, 20+ years of history
- Free tier includes news feed (100 articles/request, 50 req/hr, 1,000/day)
- Power plan: $30/mo (flat rate)
- **Data quality story is exceptional:** Tiingo cross-checks every US price against 3–7 independent feeds, assumes each data point is wrong until validated, maintains permanent audit trails. Profitable since 2014, no outside investors.
- Best as a **fallback** if Finnhub news quality degrades

### Alternative: Marketaux
- Stock-focused news API, good for equity dashboards
- Narrower scope than general aggregators — strength for ticker-specific news
- Pricing not verified in this research

### Alternative: Alpha Vantage News Sentiment
- Includes sentiment scoring
- Free tier: 25 requests/day (heavily limited)
- Paid: $49.99/mo
- Total overlap with Finnhub for our use case — skip

### Verdict
**Finnhub news stays.** The problem with Top News isn't the source — it's the curation (first-6-items vs significance ranking). Fix the ranking algorithm before switching providers. Keep Tiingo in the back pocket as a free backup.

---

## 6. What Do Similar Products Use?

Morning Brew, 1440, and similar editorial newsletters are **human-written** — they don't use market data APIs for content generation. Their "data pipeline" is journalists and editors.

The closest API-driven comparison would be automated briefing products (e.g., Yahoo Finance's daily brief, brokerage morning notes), which typically use:
- A market data vendor (Bloomberg, Refinitiv, or FMP/FMP-equivalent) for prices and calendars
- A news wire (Benzinga, MT Newswires, or Finnhub-equivalent) for headlines
- Proprietary or LLM-based summarization

Morning Brief's approach (API data + LLM summarization + editorial structure) is closest to this model. The key differentiator isn't the data source — it's the **curation and personalization layer** on top.

---

## Implementation Priority

### Phase 1 — Now ($22/mo)
1. **Subscribe to FMP Starter** (annual billing)
2. Replace headline-scraped analyst detection with `stable/grades-latest-news`
3. Filter to last 24h, format as: `TICKER — Firm raises to Overweight from Neutral, target $240 (was $200)`
4. This immediately upgrades the weakest section to institutional quality

### Phase 2 — When needed ($0)
1. Implement Top News significance ranking (pull 40–50 stories, cluster duplicates, rank by market impact)
2. Expand Before the Bell to ETF proxies (already planned, Finnhub free)
3. No new API needed

### Phase 3 — Scale triggers
1. **Tiingo** ($0–30/mo): If Finnhub news quality or reliability degrades
2. **Benzinga API** (custom pricing): If >10,000 paying subscribers and speed matters
3. **FMP Premium** ($59/mo): If fundamental data becomes a product feature

---

## Reliability Notes

- **FMP**: Established provider, widely used. The `stable/` API version indicates production-ready endpoints. Rate limits on Starter (300/min) are generous for batch workloads.
- **Finnhub**: Free tier has been stable. The 60/min limit is per API key. No SLA on free tier, but the batch runs at 4 AM ET when load is low.
- **Risk mitigation**: Both FMP and Finnhub have overlapping coverage (quotes, news, calendar). If one goes down, the pipeline can degrade gracefully to the other for critical sections.
- **Monitoring**: Add API response time + error rate logging to the pipeline. Alert if any provider fails 2 consecutive runs.

---

## Sources

- FMP education: "Best APIs for Tracking Analyst Revisions" (site.financialmodelingprep.com)
- FMP education: "5 Stocks With Big Analyst Rating Moves" (site.financialmodelingprep.com)
- GitHub: socratic-trade market-data-provider-pricing.md (verified 2026-07-10)
- dev.to: "How to Choose the Best Stock API in 2026" (Sep 2026)
- Medium: "The Great Financial Data API Showdown"
- Medium: "Top 5 Finance News APIs for 2026"
- Tiingo blog: data quality methodology (2026)
- ainvest.com: Benzinga business model and API platform coverage (2026)
- walletinvestor.com: Polygon/Massive vs competitors pricing (2026)
