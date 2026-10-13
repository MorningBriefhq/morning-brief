# Technical Implementation Plan
## Morning Brief Pipeline Rebuild

### Current State (2026-10-13)
- Pipeline runs but produces low-quality output
- AI model fixed, article extraction built, quality gates added
- Waiting on API keys: Alpaca, Marketaux, Guardian, FRED, Alpha Vantage

### Phase 1: Data Sources (Can do now)
- [x] Nasdaq earnings API integrated (no key, verified working)
- [ ] RSS parsers: Bloomberg Markets, MarketWatch, CNBC (descriptions only, no pictures)
- [ ] Article text extractor (built, needs testing)
- [ ] Multi-source news provider (built, needs keys)

### Phase 2: API Integration (Needs Pat's keys)
- [ ] Alpaca News: replace Finnhub for article bodies
- [ ] Marketaux: add sentiment + better summaries
- [ ] Guardian: full-text for top stories
- [ ] FRED: economic calendar
- [ ] Alpha Vantage: daily sentiment snapshot

### Phase 3: Pipeline Redesign
- [ ] Restructure stages: Ingest → Enrich → Summarize → Assemble → Send
- [ ] Add story scoring (market impact, novelty, source quality)
- [ ] Top 5 selection (not just first 5)
- [ ] "Stocks to Watch" as editorial (not personalized)
- [ ] Quality gates before send

### Phase 4: Testing
- [ ] Full pipeline dry run with real data
- [ ] Summary quality review (LSEG comparison)
- [ ] Email rendering test
- [ ] Failure mode testing (what if API down?)

### Phase 5: Deploy
- [ ] Deploy to production
- [ ] Monitor first 3 daily runs
- [ ] Adjust based on quality

### Code Changes Needed
1. `lib/news-multi.js` — Already built, needs keys wired in via env vars
2. `lib/article.js` — Built, needs integration testing
3. `worker.js` — Update `buildProviders` to use multi-source
4. `stages.js` — Add story scoring, top-5 selection
5. New: `lib/rss.js` — RSS feed parsers
6. New: `lib/earnings-nasdaq.js` — Nasdaq earnings integration

### Environment Variables Needed
- `ALPACA_API_KEY` — Alpaca News
- `MARKETAUX_API_KEY` — Marketaux
- `GUARDIAN_API_KEY` — Guardian
- `FRED_API_KEY` — FRED economic data
- `ALPHA_VANTAGE_API_KEY` — AV sentiment

### Risk Mitigation
- Each source has a fallback (if Alpaca down → Marketaux → Finnhub → RSS)
- Quality gates prevent bad sends
- Article scraper as last resort for full text
- Pipeline logs each source's success/failure for debugging
