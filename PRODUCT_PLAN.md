# Morning Brief — Product Rebuild Plan
## October 13, 2026

### Philosophy
**Product first, schedule second.** The brief is the product. The pipeline serves the brief.
Better to send a great brief at 8 AM than garbage at 6 AM.

### Competitive Bar: LSEG Morning News Call
Structure we're matching:
1. **Before the Bell** — futures + specific catalysts
2. **Top News** — 5 stories, 80-90 word summaries (WHAT + WHY IT MATTERS + WHAT NEXT)
3. **Stocks to Watch** — editorial picks (NOT personalized)
4. **Analyst Moves** — firm + action + reason
5. **Earnings Today** — with expected EPS
6. **Economic Calendar** — releases with times
7. **Picture of the Day** — Unsplash or nothing

### Data Architecture (Best of Breed, All Free)

| Section | Primary Source | Fallback | Notes |
|---|---|---|---|
| Top News bodies | Alpaca News API (Benzinga full text) | Bloomberg RSS → scrape | KEY: Alpaca key needed |
| News discovery | Marketaux (sentiment + summaries) | Finnhub headlines | KEY: Marketaux key needed |
| Deep dives | Guardian API (full text) | Article scraper | KEY: Guardian key needed |
| Market data | Finnhub (quotes) | — | Already working |
| Analyst ratings | FMP grades | Alpaca keyword | Already working |
| Earnings calendar | Nasdaq API (no key!) | FMP earnings-calendar | Nasdaq verified live |
| Economic calendar | FRED (free key) | — | KEY: FRED key needed (1-min signup) |
| Sentiment | Alpha Vantage NEWS_SENTIMENT | Marketaux | KEY: AV key needed (25/day) |
| Pictures | Unsplash | Nothing | Already working, no CNBC fallback |

### Pipeline Stages (Redesigned)

**Stage 1: Ingest (4 AM ET target)**
- Fetch top news from Alpaca + Marketaux (dedupe by headline similarity)
- Fetch market data from Finnhub
- Fetch earnings from Nasdaq API
- Fetch economic calendar from FRED
- Store raw in D1

**Stage 2: Enrich**
- For top 5-6 stories: fetch full article text (Alpaca body → Guardian → scraper)
- Score stories by: market impact, novelty, source quality
- Select top 5 for Top News, next tier for Stocks to Watch

**Stage 3: Summarize**
- AI generates 80-90 word summaries with: WHAT (specifics) + WHY IT MATTERS (mechanism) + WHAT TO WATCH
- New model: llama-3.3-70b (old 8b was deprecated)
- Quality check: summary must be >100 chars, not equal to headline

**Stage 4: Assemble**
- QUALITY GATE: abort if no real summaries — don't ship garbage
- Build email with all sections
- "Your Stocks" only if user has tickers (opt-in)

**Stage 5: Send**
- Resend API
- BRIEFING_FROM must be set (was missing!)

### Quality Gates (New)
1. **Summaries exist**: At least 3 top news with summaries >100 chars
2. **Summaries aren't headlines**: Summary != headline, length check
3. **Market data present**: Before the Bell has futures data
4. **No empty sends**: If gates fail, alert — don't send

### What Changed from Before
- ❌ Removed: Per-user ticker personalization as core (now opt-in side feature)
- ❌ Removed: CNBC/news-thumbnail picture fallback
- ❌ Removed: 30-word and 60-word summary caps
- ✅ Added: Article text extraction (full content, not headlines)
- ✅ Added: Multi-source news (Alpaca + Marketaux + Guardian + RSS)
- ✅ Added: Quality gates (don't ship bad briefs)
- ✅ Added: Nasdaq keyless earnings API
- ✅ Fixed: AI model (deprecated → current)
- ✅ Fixed: nowSec bug (was crashing all stages)
- ✅ Fixed: BRIEFING_FROM missing (was blocking all emails)

### Keys Needed from Pat (All Free)
1. Alpaca (alpaca.markets) — CRITICAL, full article text
2. Marketaux (marketaux.com) — sentiment + summaries
3. Guardian (open-platform.theguardian.com) — full text
4. FRED (fredaccount.stlouisfed.org/apikeys) — economic calendar
5. Alpha Vantage (alphavantage.co) — sentiment (25/day)

### Implementation Order
1. Wire in new API keys when Pat provides them
2. Deploy multi-source news provider
3. Test full pipeline with real data
4. Verify summary quality meets LSEG bar
5. Deploy quality gates
6. Resume daily sends

### Success Criteria
- Summaries explain WHAT happened with specifics, WHY it matters, WHAT to watch
- No headline-repeats, no empty sections
- Brief reads like LSEG quality, not a headline aggregator
- If data is bad, we don't send (and Pat gets alerted)

### Anticipated Questions (Pat)

**Q: How do we pick "Stocks to Watch"?**
A: Editorial scoring, not personalized:
- Biggest premarket movers (>3%)
- Earnings reporters today with high expectations
- Stocks with unusual analyst activity
- M&A targets/acquirers
- Max 4-5, ranked by market impact

**Q: Are we staying on free tiers?**
A: Yes. Daily usage estimate:
- Alpaca: ~10 req/day (well under 200/min limit)
- Marketaux: ~15 req/day (under 100/day limit)
- Guardian: ~5 req/day (under 5,000/day limit)
- FRED: ~2 req/day (generous free tier)
- Alpha Vantage: 1 req/day (under 25/day limit)
- Workers AI: ~15 calls/day (well under free tier)
- Resend: 3 emails/day (free tier is 100/day)
Total cost: $0

**Q: When will it be ready?**
A: Blocked on API keys from Pat. Once keys are in:
- Day 1: Wire keys, test each source
- Day 2: Full pipeline dry run, quality review
- Day 3: Deploy, monitor first live run
Realistic: 3 days after keys received.

**Q: Will the archive show the new format?**
A: New briefs use new format. Old archive entries stay as-is (historical record).

### Length Policy (Pat, 2026-10-13)
- NO artificial length limits. No "5-minute read" constraint.
- If there's important information, include it.
- Importance judgment: Muse decides what's big enough.
- General rule: S&P 500 companies are important. Fall back to S&P 100 if there's too much on a given day.
- The brief is as long as it needs to be. Density over brevity.

### Substance Rule (Pat, 2026-10-13)
"No filler but big news of substance."

Every story must earn its place. No padding, no fluff, no "in other news" filler.
But when there's real substance — include it fully. Don't cut important detail to hit an arbitrary length.

The test: would a serious investor feel uninformed without this? If yes, it's in. If no, it's out.
