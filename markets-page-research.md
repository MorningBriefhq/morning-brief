# Markets Page Research — How the Best Sites Display Market Data

**Date:** 2026-10-12
**Question:** How do we make morningbrief.link/markets "tighter and more useful"?
**Principles:** "Useful information, no bullshit. Packed." / "Big on important information without filler."

---

## 1. What the best sites actually do

### Yahoo Finance — Markets page
The reference implementation for "dense but scannable." A plain **table**: Symbol | Price | Change %. Organized by **region** (US, Europe, Asia), 7–8 rows per section. Every row shows the full triplet: `7,651.54 / -19.30 (-0.25%)` — price, absolute change, percent change, always together. VIX and Dollar Index sit alongside the equity indices, not buried in a separate tab. On mobile it's one instrument per row, ~8 visible without scrolling. No charts, no decoration — the density IS the feature.

### Finviz — homepage + futures page
Density as brand identity. The front page puts indices, commodities, currencies, and interest rates in **one continuously updated view** — no tabs, no clicking. The futures page shows price, change, and a small chart per contract. The lesson: serious users don't want to hunt across tabs; they want the whole board visible. Finviz fits ~30 instruments above the fold on desktop because each row is ~24px tall. It looks "ugly" and gets 100M+ visits because every pixel is data.

### Bloomberg — markets page
**Tabs by region** (Americas / Europe / Asia) for indices, then separate sections for futures, bonds, currencies, commodities. Two critical conventions: (1) **futures are separated from spot** — premarket you see ES/NQ/YM futures, during hours you see the cash index; they never blur the two. (2) **Bonds are quoted as yield, never price.** Nobody in finance says "TLT is up 0.5%"; they say "the 10-year is at 5.31%." Color is applied to the change figure only, not the whole row.

### CNBC — premarket/data pages
**Futures-first before the open.** Their premarket page leads with Dow/S&P/Nasdaq futures and the implied open, then commodities, currencies, global indexes — in that priority order. The ordering tells you what matters when: futures > commodities > FX > global. After the open, the same page flips to spot. The takeaway: the page should know **what session it's in** and lead with the relevant number.

### TradingView — watchlist / market overview widget
The watchlist row is the atomic unit done right: **symbol, price, change, % change, optional sparkline**. Their Market Overview widget makes the sparkline toggleable — and the default is ON, because a 12-month sparkline next to the number answers "is this a blip or a trend?" without a click. The ticker-tape widget (horizontal scrolling price + change) is decorative; the watchlist is useful. Lesson: sparklines earn their place when they show **trend shape**, not decoration.

### WSJ Markets
Same triplet as Yahoo (price / change / % change), organized Stocks → Bonds → Commodities → Currencies. Conservative, tabular, tabular numerals. The WSJ convention worth stealing: **section order reflects a macro narrative** — equities first, then the rates that drive them, then the commodities/currencies that react.

---

## 2. The universal pattern — what everyone agrees on

Across all six, the non-negotiables:

1. **Price + absolute change + % change, always together.** `7,651.54  -19.30 (-0.25%)`. No exceptions. A percent change without a price is nearly meaningless — you can't tell 7,800 from 4,000.
2. **Bonds = yield.** The 10-year Treasury is quoted as "5.31%", never as an ETF price. Bond prices move inversely to yields, so showing TLT's % change is actively misleading to anyone who thinks in yields (i.e., everyone).
3. **VIX is always present.** Every single site shows the fear gauge next to the indices. It's one number that summarizes market anxiety. Its absence is the most conspicuous gap on our page.
4. **Session awareness.** Premarket → futures. Open → spot. The label matters ("as of 7:42 AM ET, premarket").
5. **Color on the change, not the row.** Green/red is applied to the change figure. The rest stays neutral. (Also: never rely on color alone — always show the +/− sign.)
6. **Density wins.** The useful pages fit 8–30 instruments per screen. The decorative ones fit 3.

---

## 3. What's wrong with the current page (specific)

1. **% change with no price.** The single biggest gap. "+0.35%" for the Dow tells you nothing without knowing the level.
2. **TLT shown as a price move.** "20-Yr Treasury +0.09%" reads as noise. What the reader wants: "10Y yield 5.31%". Worse, it's *inverted information* — TLT up means yields down, which is the opposite of how every reader thinks.
3. **No VIX.** The one number every market participant checks. Missing entirely.
4. **Cards are too airy.** 1.4rem values, 1.25rem padding, big section gaps — roughly 3 instruments visible per phone screen. This is a data page wearing a marketing page's clothes.
5. **The lede paragraph wastes the fold.** "Key numbers at a glance. For the full picture with context, read today's edition." — on mobile this pushes the actual data below the fold. On a data page, the data IS the headline.
6. **"Europe" and "Japan" as ETF proxies** are weak signal without labels. EFA −0.34% doesn't tell you if that's DAX, FTSE, or CAC. Either show the real indices or label honestly.
7. **No session context.** "Live — updated 8:15 PM" at night shows stale ETF quotes with no indication the market is closed.

---

## 4. Recommendation — exact layout

### Above the fold: the one-line snapshot
One sentence, not a hero. The three numbers that answer "what's happening":

> **S&P futures +0.4% · 10Y 5.31% · VIX 14.8** — premarket, 7:42 AM ET

This is the Bloomberg/CNBC instinct: futures direction, the rate, the fear gauge. If the reader reads nothing else, they got the market. On mobile this is one line (maybe two). It updates live.

### Body: compact tables, one row per instrument

```
US INDICES                    Price       Chg         % Chg
S&P 500 futures      [spark]  7,838.90    +31.20     +0.40%
Nasdaq 100 futures   [spark]  27,410.00   -68.50     -0.25%
Dow futures          [spark]  50,940.00   +178.00    +0.35%
VIX                  [spark]  14.80       -0.40      -2.63%

RATES                         Yield       Chg (bps)
10-Year Treasury               5.31%       +4 bp
2-Year Treasury                4.87%       +2 bp

COMMODITIES                   Price       Chg         % Chg
WTI Crude            [spark]  $92.40      +$1.72      +1.91%
Gold                 [spark]  $2,981.00   -$18.90    -0.63%

CURRENCIES                    Price       Chg         % Chg
Dollar Index (DXY)   [spark]  102.42      +0.18       +0.18%
EUR/USD              [spark]  1.0842      -0.0021     -0.19%

GLOBAL
Nikkei 225           [spark]  68,956.72   +2,203.00   +3.30%
DAX                  [spark]  25,065.50   -133.69     -0.53%
FTSE 100             [spark]  10,438.88   -167.12     -1.58%
```

Section order follows the WSJ macro narrative: equities → the rates that drive them → commodities/currencies that react → global.

### Per-row anatomy (the atomic unit)
- **Name** (left, regular weight): "S&P 500 futures" — and it must say *futures* premarket, *cash* during hours. Never ambiguous.
- **Sparkline** (center, ~60×20px): intraday path. This is the single highest-value addition — it turns a static number into "how did we get here." 1-day range, auto-scaled, green/red by day direction.
- **Price** (right, tabular numerals, semibold)
- **Change**: absolute + percent, e.g. `+31.20 (+0.40%)`, colored, always signed.

Row height target: **48px**. That's ~10 rows per phone screen. Finviz does 24px; we're not Finviz, but 48px is the "packed but tappable" compromise.

### Footer line
> As of 7:42 AM ET · Futures premarket · Data: Finnhub · ETF proxies where noted

Honest about what's a proxy. One line, muted.

---

## 5. ADD list (ranked)

1. **Price on every instrument.** Non-negotiable. The API already has `c` (current price) from Finnhub — it's just not being sent to the page. Zero new API cost.
2. **Absolute change.** Also already in the Finnhub response (`d` field). Zero new API cost.
3. **VIX.** The missing fear gauge. Check Finnhub free tier for a VIX quote (VIX index or VIXY ETF proxy). If unavailable, FMP free tier may carry it.
4. **10-year yield as a yield.** Replace "20-Yr Treasury +0.09%" (TLT price move) with "10Y 5.31%, +4bp". Source: FMP free tier has Treasury rates; or ^TNX on Finnhub if available. Quoting TLT's price change as "bonds" is the most misleading thing on the current page — fix first.
5. **2-year yield.** The 10Y–2Y spread is the recession-watch number. One extra row, huge signal. Same source as #4.
6. **Intraday sparklines.** Finnhub `/candle` with 5- or 15-min resolution (verify free-tier access; fallback: FMP intraday). Render as inline SVG, no chart library — ~20 lines of JS. This is what makes the page feel *alive* instead of a static table.
7. **Session label.** "Premarket" / "Open" / "Closed" derived from time + a market-hours check. CNBC does this; it prevents the #1 misread ("why aren't numbers moving" at 9 PM).
8. **Futures vs spot switching.** Premarket (4 AM–9:30 AM ET): show ES/NQ/YM futures. During hours: show cash. This is the Bloomberg convention and it's what "Before the Bell" already implies. (Current ETF proxies SPY/QQQ/DIA blur this — they trade premarket so they're *okay*, but label them.)
9. **DXY instead of (or alongside) UUP.** The Dollar Index is the standard quote; UUP is a fine proxy but DXY is what everyone references.
10. **Real global indices** (Nikkei, DAX, FTSE) instead of EFA/EWJ ETF blobs — *if* the data source supports it. If not, keep the ETFs but label "Europe (EFA proxy)".

## 6. CUT list

1. **The lede paragraph.** "Key numbers at a glance..." — delete. On a data page the data is the headline. Replace with the one-line snapshot (§4).
2. **Card chrome.** The bordered cards with 1.25rem padding are marketing-page furniture. Replace with hairline-divided table rows. Saves ~40% vertical space.
3. **Section header letter-spacing ceremony.** 0.85rem uppercase with 1.5px tracking and 2rem top margins — shrink to compact 0.75rem labels with 1rem spacing. Headers should be signposts, not monuments.
4. **"International" as a category name.** Vague. Split into the actual regions or call it "Global indices."
5. **Any instrument that can't show a price.** If a quote fails, drop the row (current behavior of showing "—" is fine as a fallback, but a page full of dashes is worse than a shorter page).
6. **The "read today's edition" CTA in the body.** One link in the header nav is enough. This page serves a different job (quick check) than the newsletter (context). Don't cross-sell mid-data.

---

## 7. Mobile-first specifics

- **One row per instrument, full width.** No 2-column grids on phones — the current `minmax(160px, 1fr)` grid squeezes price + change into unreadable columns.
- **Sticky section headers** so "RATES" stays visible while scrolling commodities.
- **Tabular numerals everywhere** (already done on the site — keep it).
- **Touch target ≥ 44px** per row — the 48px row height covers this.
- **Sparkline: keep on mobile.** At 60×20px it's glanceable, not clutter. TradingView's mobile app kept sparklines in the watchlist for exactly this reason.
- **No horizontal scrolling.** If it doesn't fit in 360px, cut it. The absolute change can drop to just % on very narrow screens (keep price + %; absolute change is the first to go under 360px).
- **Dark mode:** green/red need the muted variants already in the CSS (`#4caf6d`/`#e57373`). Pure #00ff00-style greens vibrate on dark backgrounds.

## 8. Data sourcing (free stack feasibility)

All "already have it" items come from the existing Finnhub `/quote` calls — the worker just needs to pass `c` (price) and `d` (absolute change) through the `/api/market-live` endpoint. No new calls.

New items to verify:
- **VIX:** try Finnhub `/quote?symbol=VIX` (CBOE index coverage on free tier is uncertain); fallback `VIXY` ETF; fallback FMP.
- **Treasury yields:** FMP free tier has a treasury-rates endpoint; alternatively Finnhub `^TNX`/`^FVX` symbols (uncertain on free). Verify before building.
- **Sparklines:** Finnhub `/stock/candle?resolution=5` for today's session. Free tier historically includes intraday US candles; verify. 9 instruments × 1 call each, cached 5 min — well within 60/min. Fallback: FMP 15-min intraday.
- **Session detection:** pure time logic in the worker or the page — no API needed. US market hours 9:30 AM–4 PM ET, premarket 4–9:30 AM.

Rate-limit note: sparklines add 9 calls per refresh cycle. Combined with the 9 quote calls = 18 calls per 5-min window ≈ 4/min. Still under 10% of the 60/min free tier. Fine.

## 9. Principles check

- **"Useful information, no bullshit":** every row answers "where is it and how much did it move" — the two questions. Nothing answers a question nobody asked.
- **"Packed":** 48px rows, ~10 instruments per phone screen, the whole board in two scrolls. Compare: current page shows ~3 per screen.
- **"No filler":** no hero, no lede paragraph, no marketing CTAs mid-data. The snapshot line (§4) is content, not chrome.
- **Bloomberg meets Stratechery:** Bloomberg's data density and conventions (yield not price, futures/spot discipline, session awareness) + Stratechery's restraint (nothing decorative, every element justified).

---

## Sources consulted

- Yahoo Finance Markets page structure (via text mirror): Symbol | Price | Change % tables by region (US/Europe/Asia), VIX + Dollar Index alongside indices
- Finviz: front-page dashboard density (indices, commodities, currencies, rates in one view); futures page with price/change/charts
- Bloomberg Markets: regional tabs, futures/spot separation, bonds-as-yield convention (general knowledge + terminal conventions)
- CNBC premarket pages: futures-first ordering, implied open, commodities/currencies/global below
- TradingView: watchlist row anatomy (symbol/price/change/%/sparkline), Market Overview widget sparkline defaults
- WSJ Markets: Stocks → Bonds → Commodities → Currencies section order
- Current macro context (Oct 2026): 10Y ~5.3%, VIX ~14.8, WTI ~$92 — confirms 10Y yield and VIX are the two macro numbers readers expect
