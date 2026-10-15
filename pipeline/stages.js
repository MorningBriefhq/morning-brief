// Morning Brief pipeline — stages.
//
// All stages are written against the D1 statement interface:
//   db.prepare(sql).bind(...).first()  -> row | null
//   db.prepare(sql).bind(...).all()    -> { results: [...] }
//   db.prepare(sql).bind(...).run()    -> { success: true }
// which holds for real D1 and for the node:sqlite shim in local-run.js.
//
// Idempotency: every stage is safe to re-run for the same run_date.
// Summaries are generated ONCE per (run_date, ticker) and shared across users.

import { signToken } from "./lib/sign.js";
import { renderTemplate } from "./lib/render.js";
import { truncateWords, capSummary } from "./lib/summarize.js";
import { fetchEconCalendar } from "./lib/econ.js";
import { fetchRecent8Ks } from "./lib/edgar.js";
import { fetchEarningsCalendarAV } from "./lib/alphavantage.js";
import { TICKER_CIK } from "./lib/edgar-ciks.js";

/** Error thrown when the quality gate blocks a send.
 *  Distinct from a crash: the pipeline worked, but the data isn't good enough to ship.
 *  runStage records this as status='blocked' (not 'done', not 'failed'). */
export class QualityBlockedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "QualityBlockedError";
    this.details = details;
  }
}

/** Extractive fallback summary: first 2-3 substantive sentences of fullText.
 *  Used ONLY when AI summarization fails — better than shipping empty.
 *  (Pat's rule is our-voice synthesis; this is a safety net, not the path.) */
function extractiveSummary(story, maxWords = 150) {
  const text = (story.fullText || story.summary || "").trim();
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 30);
  return truncateWords(sentences.slice(0, 3).join(" "), maxWords);
}

/**
 * Enrich earnings rows with Pat's 5-item rule: EPS estimate, actual-vs-consensus
 * surprise (reported names), 3-mo performance, IR link.
 *
 * - estimate: already on the row (Alpha Vantage CSV, Finnhub epsEstimate).
 * - surprise: Finnhub /stock/earnings — latest quarter whose period ended within
 *   7 days before runDate (i.e. just reported), with actual vs consensus.
 * - perf3mo: Finnhub /stock/candle daily closes, first -> last over ~3 months.
 * - irLink: Finnhub /stock/profile2 weburl; falls back to the SEC EDGAR company
 *   page via TICKER_CIK (authoritative, always valid — never a guessed URL).
 *
 * Finnhub basics are free tier (60 calls/min); a 12-name calendar costs ~36.
 * No-ops when the market provider exposes no _get() (e.g. mock mode).
 * Also formats the display fields the template consumes:
 *   time            "Oct 15 · Before open" (date + time per Pat's rule)
 *   earnings_detail "EPS est $2.45 · +8.4% last 3 mo"
 *                   "Reported $2.55 vs $2.45 est (+4.1%) · +8.4% last 3 mo"
 */
async function enrichEarnings(earnings, { runDate, finnhubGet }) {
  if (!Array.isArray(earnings) || earnings.length === 0) return;
  const dayMs = 864e5;
  const runMs = Date.parse(runDate + "T12:00:00Z");
  const fromSec = Math.floor((runMs - 92 * dayMs) / 1000);
  const toSec = Math.floor(runMs / 1000);
  const dateShort = new Date(runMs).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });

  const fmtMoney = (v) => {
    const n = Number(String(v).replace(/[$,]/g, ""));
    return isNaN(n) ? null : `$${n.toFixed(2)}`;
  };
  const fmtPct = (v, digits = 1) => {
    const n = Number(v);
    if (isNaN(n)) return null;
    return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
  };

  for (const e of earnings) {
    // Time badge carries the date explicitly (Pat's 5-item rule).
    // Strip any existing YYYY-MM-DD prefix (mock provider) before adding ours.
    e.time = (e.time || "").replace(/^\d{4}-\d{2}-\d{2} · /, "");
    if (e.time && !e.time.startsWith(dateShort)) e.time = `${dateShort} · ${e.time}`;
    // IR link: authoritative sources only — profile weburl, else SEC EDGAR.
    if (!e.irLink && typeof finnhubGet === "function") {
      try {
        const prof = await finnhubGet(`/stock/profile2?symbol=${encodeURIComponent(e.ticker)}`);
        if (prof && prof.weburl) e.irLink = prof.weburl;
      } catch (err) {
        console.error(`[market] earnings profile ${e.ticker}:`, err.message);
      }
    }
    if (!e.irLink) {
      const cik = TICKER_CIK[(e.ticker || "").toUpperCase()];
      if (cik) {
        e.irLink = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`;
      }
    }
    if (typeof finnhubGet !== "function") {
      // Mock mode: no enrichment possible, but still format the detail line.
      e.earnings_detail = fmtEstLine(e, fmtMoney, null, null);
      continue;
    }
    const sym = encodeURIComponent(e.ticker);
    // Actual-vs-consensus surprise for just-reported names.
    let surprise = null;
    try {
      const hist = await finnhubGet(`/stock/earnings?symbol=${sym}`);
      const latest = Array.isArray(hist) && hist[0];
      if (latest && latest.actual != null) {
        const periodMs = Date.parse(`${latest.period}T00:00:00Z`);
        if (!isNaN(periodMs) && periodMs <= runMs && runMs - periodMs <= 7 * dayMs) {
          surprise = {
            actual: Number(latest.actual),
            estimate: latest.estimate != null ? Number(latest.estimate) : null,
            pct: latest.surprisePercent != null ? Number(latest.surprisePercent) : null,
          };
        }
      }
    } catch (err) {
      console.error(`[market] earnings surprise ${e.ticker}:`, err.message);
    }
    // 3-month performance from daily candles.
    let perf3mo = null;
    try {
      const candles = await finnhubGet(
        `/stock/candle?symbol=${sym}&resolution=D&from=${fromSec}&to=${toSec}`
      );
      const closes = candles && candles.c;
      if (Array.isArray(closes) && closes.length >= 2 && closes[0] > 0) {
        perf3mo = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
      }
    } catch (err) {
      console.error(`[market] earnings 3mo ${e.ticker}:`, err.message);
    }
    e.earnings_detail = fmtEstLine(e, fmtMoney, fmtPct, surprise, perf3mo);
  }
}

/** One-line detail for an earnings row. Empty string when nothing is known. */
function fmtEstLine(e, fmtMoney, fmtPct, surprise, perf3mo) {
  const parts = [];
  if (surprise && surprise.actual != null) {
    const act = fmtMoney ? fmtMoney(surprise.actual) : null;
    const est = surprise.estimate != null && fmtMoney ? fmtMoney(surprise.estimate) : null;
    const pct = surprise.pct != null && fmtPct ? ` (${fmtPct(surprise.pct)})` : "";
    parts.push(`Reported ${act || surprise.actual}${est ? ` vs ${est} est` : ""}${pct}`);
  } else {
    const est = e.estimate != null && e.estimate !== "" && fmtMoney ? fmtMoney(e.estimate) : null;
    if (est) parts.push(`EPS est ${est}`);
  }
  if (perf3mo != null && fmtPct) {
    const p = fmtPct(perf3mo);
    if (p) parts.push(`${p} last 3 mo`);
  }
  return parts.join(" · ");
}

/**
 * Build the calendar section.
 *
 * Earnings priority: Alpha Vantage first (Finnhub's /calendar/earnings returned
 * empty on 2026-10-14 while AV's CSV did the real work), Finnhub as fallback.
 * Rows are enriched with Pat's 5-item rule: date, time, EPS estimate, IR link,
 * 3-mo performance (+ actual-vs-consensus surprise for reported names).
 * Econ: FXMacroData (free, no key) is primary; Finnhub econ kept as supplement.
 */
async function buildCalendar(market, runDate, alphavantageKey = null) {
  const out = { earnings: [], econ: [] };
  // Alpha Vantage primary for earnings — verified working 2026-10-14.
  if (alphavantageKey) {
    try {
      const av = await fetchEarningsCalendarAV(alphavantageKey, market.sp500, runDate);
      out.earnings = av.map(({ ticker, company, time, estimate }) => ({
        ticker, company, time, estimate,
      }));
    } catch (e) {
      console.error("[market] calendar (alphavantage):", e.message);
    }
  }
  // Finnhub fallback when AV is unavailable or empty.
  if (out.earnings.length === 0) {
    try {
      const cal = await market.calendar(runDate);
      out.earnings = cal.earnings || [];
      // Keep Finnhub econ as supplement if it ever returns data
      if (cal.econ && cal.econ.length > 0) {
        out.econ = cal.econ;
      }
    } catch (e) {
      console.error("[market] calendar (finnhub):", e.message);
    }
  }
  // FXMacroData primary for econ — fills the gap when Finnhub is empty
  if (out.econ.length === 0) {
    try {
      const fx = await fetchEconCalendar(7);
      out.econ = fx.map((e) => ({
        time_et: e.time_et,
        event: e.event + (e.importance === "high" ? " ★" : ""),
      }));
    } catch (e) {
      console.error("[market] calendar (fxmacrodata):", e.message);
    }
  }
  // Enrich every earnings row: estimate, surprise, 3-mo perf, IR link.
  const finnhubGet = market && typeof market._get === "function"
    ? market._get.bind(market)
    : null;
  await enrichEarnings(out.earnings, { runDate, finnhubGet });
  return out;
}

export async function runMarket({ db, market, news, runDate, nowSec, summarizer = null, alphavantageKey = null }) {
  // Use the multi-source news provider (Marketaux + Guardian + RSS) for Top News.
  // Falls back to market.topNews (Finnhub) if no news provider.
  const topNews = news && typeof news.topNews === "function"
    ? await news.topNews(null, null, 8)
    : await market.topNews(runDate);

  // Enrich stories with synthesized summaries from MULTIPLE sources.
  // We pool Marketaux, Guardian, RSS — the AI synthesizes into our own voice.
  // Prefer the fullest text available (Guardian bodyText) as the primary source;
  // the short snippet is backup context. Skip URL scraping (too slow).
  // If AI fails for a story, fall back to extractive so we never ship "".
  let aiFailures = 0;
  let aiAttempts = 0;
  if (summarizer && typeof summarizer.summarizeStory === "function") {
    for (const s of topNews) {
      try {
        // Use API-provided text only — no slow URL scraping.
        // Full text first (Guardian bodyText is the richest), snippet second.
        const sources = [];
        if (s.fullText) sources.push({ source: "full-text", text: s.fullText.slice(0, 2000) });
        if (s.summary) sources.push({ source: "summary", text: s.summary.slice(0, 1500) });
        if (sources.length === 0) continue;
        aiAttempts++;
        const inputLen = sources.reduce((n, src) => n + (src.text || "").length, 0);
        const raw = await summarizer.summarizeStory(s.headline, sources);
        const capped = capSummary(raw);
        if (capped.length < 100) {
          // Thinness made visible: log input length next to the short summary.
          console.warn(
            `[market] thin summary for "${(s.headline || "").slice(0, 80)}": ` +
            `input ${inputLen} chars -> summary ${capped.length} chars`
          );
        }
        s.summary = capped;
      } catch (e) {
        aiFailures++;
        console.error("[market] story summary failed:", e.message);
        // Extractive fallback — never leave summary empty
        const fallback = extractiveSummary(s);
        if (fallback) s.summary = capSummary(fallback);
      }
    }
  }
  if (aiAttempts > 0 && aiFailures === aiAttempts) {
    console.error(`[market] ALL ${aiAttempts} AI summaries failed for ${runDate} — check Workers AI binding/model. Using extractive fallbacks.`);
  }

  const sections = {
    top_news: topNews,
    before_bell: await market.beforeBell(runDate),
    // Futures strip (email header) + overnight block (Asia/Europe): real
    // index/futures quotes from the same keyless fetch. Missing providers
    // degrade to empty sections, never ETF proxies.
    futures_strip: typeof market.futuresStrip === "function" ? await market.futuresStrip(runDate) : [],
    overnight: typeof market.overnight === "function" ? await market.overnight(runDate) : { rows: [], line: "" },
    treasury_yields: typeof market.treasuryYields === "function" ? await market.treasuryYields() : null,
    calendar: await buildCalendar(market, runDate, alphavantageKey),
    picture: typeof market.pictureOfTheDay === "function" ? await market.pictureOfTheDay(topNews, summarizer) : null,
    premarket_movers: typeof market.premarketMovers === "function" ? await market.premarketMovers(topNews) : [],
  };

  // SEC EDGAR 8-Ks: "what companies did/said/announced" — the highest-signal
  // free source for Stocks to Watch. Authoritative, no key.
  let eightKs = [];
  try {
    eightKs = await fetchRecent8Ks({ daysBack: 3, maxFilings: 12 });
    if (eightKs.length > 0) {
      sections.eight_ks = eightKs;
    }
  } catch (e) {
    console.error("[market] edgar 8-Ks:", e.message);
  }

  // Stocks to Watch: AI-generated editorial picks (10-12 names with substantive reasons).
  // Based on top news and upcoming earnings. Our editorial voice.
  // Corporate news only — what companies did/said/announced. Never analyst filler.
  if (summarizer && typeof summarizer.summarizeStory === "function" && topNews.length >= 3) {
    try {
      const newsContext = topNews.slice(0, 8).map((s, i) => `${i + 1}. ${s.headline}: ${(s.summary || "").slice(0, 200)}`).join("\n");
      const earningsContext = ((sections.calendar || {}).earnings || []).slice(0, 8).map((e) => `- ${e.ticker} (${e.company})`).join("\n");
      // SEC 8-K filings: authoritative corporate actions, exactly the
      // "what companies did/said/announced" definition for Stocks to Watch.
      const eightKContext = (eightKs || []).slice(0, 10).map((f) => {
        const items = (f.items || []).map((it) => `${it.item} ${it.label}`).join("; ");
        return `- ${f.ticker} (${f.company}), filed ${f.filedDate}: ${items}`;
      }).join("\n");

      const stwPrompt =
        `You are writing the "Stocks to Watch" section for a morning market newsletter. ` +
        `Write in the style of LSEG Morning News Call: factual, specific, no speculation.\n\n` +
        `Format for each: "• TICKER Company Name: [what the company said/did/announced, with specific numbers and attribution]"\n\n` +
        `Examples of GOOD entries:\n` +
        `• AEVEX Corp: Drone maker AEVEX said on Thursday that it had raised $320 million in its U.S. initial public offering after pricing shares at $20 each. The company sold 16 million shares within its indicated price range of $18 to $21 apiece.\n` +
        `• Ford Motor Co: The company is recalling about 1.4 million F-150 pickup trucks in the U.S. following a National Highway Traffic Safety Administration investigation into reports of unexpected downshifts, the regulator said.\n` +
        `• Uber Technologies Inc: Prosus has agreed to sell a 4.5% stake in Delivery Hero to Uber for about 270 million euros ($318 million), making the ride-hailing group the fourth-largest shareholder, the companies said.\n\n` +
        `Rules:\n` +
        `- Lead with what the company DID, SAID, or ANNOUNCED. Specific facts only.\n` +
        `- Include specific numbers: dollar amounts, share counts, percentages, dates.\n` +
        `- Attribute: "the company said," "according to," "the regulator said."\n` +
        `- NEVER write: "missed/beat expectations," "watch for," "investors will focus on," "sets the tone," "whether X signals Y."\n` +
        `- NEVER mention analyst revisions, price targets, or Seeking Alpha.\n` +
        `- If a company only has "reports earnings tomorrow" with no specific news, SKIP IT.\n` +
        `- Pick as many as have real news. Fewer strong picks beat padded filler.\n\n` +
        `Base picks on the news and earnings below. Favor S&P 500 companies. ` +
        `No investment advice. Format as a JSON array: [{"ticker": "AVGO", "company": "Broadcom", "reason": "..."}, ...]\n\n` +
        `Top news:\n${newsContext}\n\nEarnings:\n${earningsContext || "(none)"}\n\nSEC 8-K filings (authoritative corporate actions):\n${eightKContext || "(none)"}`;

      const rawStw = await summarizer.summarizeStory("Stocks to watch", [{ source: "context", text: stwPrompt }]);
      // Try to parse as JSON, fallback to empty
      try {
        const jsonMatch = rawStw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const picks = JSON.parse(jsonMatch[0]);
          if (Array.isArray(picks) && picks.length > 0) {
            sections.stocks_to_watch = picks.slice(0, 12).map((p) => ({
              ticker: p.ticker || "",
              company: p.company || "",
              reason: p.reason || "",
            })).filter((p) => p.ticker && p.reason);
          }
        }
      } catch (parseErr) {
        console.error("[market] stocks-to-watch parse failed:", parseErr.message);
      }
    } catch (e) {
      console.error("[market] stocks-to-watch generation failed:", e.message);
    }
  }

  // Thesis-led open: substantive take on the day (Yardeni-style).
  // Names the dominant theme BEFORE details. Neutral, sourced, no predictions without evidence.
  if (summarizer && typeof summarizer.summarize === "function" && topNews.length) {
    try {
      const headlines = topNews.slice(0, 5).map((s, i) => `${i + 1}. ${s.headline}`).join("\n");
      // before_bell rows are structured {label, level, change, pct, note};
      // legacy mock rows are {label, text}. Handle both.
      const bb = (sections.before_bell || []).map((b) => {
        if (b.text) return `${b.label}: ${b.text}`;
        const pct = b.pct == null ? "" : ` (${b.pct >= 0 ? "+" : ""}${b.pct.toFixed(2)}%)`;
        return `${b.label}: ${b.level}${pct}${b.note ? ` ${b.note}` : ""}`;
      }).join("; ");
      // Overnight (Asia/Europe) feeds the thesis too — it names what's
      // already happened while the US slept.
      const ovLine = (sections.overnight && sections.overnight.line) || "";
      const thesisPrompt =
        `Give a neutral, substantive take on today's market setup for a morning investor briefing. ` +
        `Name the 1-2 dominant themes driving markets this morning. State what matters and why, not predictions. ` +
        `Get the key points across — as long as they need, as short as they can be. Facts only from the headlines below. No investment advice.\n\n` +
        `Overnight market data: ${bb}${ovLine ? `\nOvernight (Asia/Europe): ${ovLine}` : ""}\n\nTop stories:\n${headlines}`;
      // Use the story summarizer if available, else skip
      if (typeof summarizer.summarizeStory === "function") {
        const rawThesis = await summarizer.summarizeStory("Today's market setup", thesisPrompt);
        const thesis = truncateWords(rawThesis, 100);
        if (thesis && thesis.length > 20) sections.day_take = thesis;
      }
    } catch (e) {
      console.error("[market] thesis generation failed:", e.message);
    }
  }
  for (const [section, payload] of Object.entries(sections)) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO market_briefs (run_date, section, payload, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(runDate, section, JSON.stringify(payload), nowSec())
      .run();
  }

  // Data-quality summary: loud log of what we got vs what's missing.
  // If a section is empty, the reason is in the provider logs above.
  const sectionCounts = Object.fromEntries(
    Object.entries(sections).map(([k, v]) => [k, Array.isArray(v) ? v.length : (v ? 1 : 0)])
  );
  console.log(`[market] sections for ${runDate}: ${JSON.stringify(sectionCounts)}`);
  const emptySections = Object.entries(sectionCounts)
    .filter(([, n]) => n === 0)
    .map(([k]) => k);
  if (emptySections.length > 0) {
    console.warn(`[market] EMPTY sections for ${runDate}: ${emptySections.join(", ")} — check provider logs above for API failures`);
  }

  return sections;
}

function marketSection(rows, runDate, section) {
  const row = rows.find((r) => r.section === section);
  if (!row) {
    console.warn(`[assemble] missing market section "${section}" for ${runDate}`);
    if (section === "calendar") return { earnings: [], econ: [] };
    if (section === "picture") return null;
    return [];
  }
  return JSON.parse(row.payload);
}

/**
 * Generate social media drafts from the morning's market data.
 * X thread (3 posts) + LinkedIn long-form. Stored in DB, served via /api/social-draft.
 * The post IS useful content, not a teaser. Newsletter link lives in bio only.
 */

export async function runAssemble({
  db,
  sender,
  runDate,
  dateLong,
  origin,
  productName,
  sessionSecret,
  templateText,
  nowSec,
}) {
  const { results: briefRows } = await db
    .prepare("SELECT section, payload FROM market_briefs WHERE run_date = ?")
    .bind(runDate)
    .all();

  const topNews = marketSection(briefRows, runDate, "top_news");
  const beforeBell = marketSection(briefRows, runDate, "before_bell");
  const futuresStrip = marketSection(briefRows, runDate, "futures_strip");
  // Overnight is stored as { rows: [{label, pct}], line }; tolerate legacy rows.
  const overnightRaw = marketSection(briefRows, runDate, "overnight");
  const overnightLine = !overnightRaw || Array.isArray(overnightRaw) ? "" : (overnightRaw.line || "");
  const calendar = marketSection(briefRows, runDate, "calendar");
  const premarketMovers = marketSection(briefRows, runDate, "premarket_movers");
  const picture = marketSection(briefRows, runDate, "picture");
  const dayTake = marketSection(briefRows, runDate, "day_take");

  // QUALITY GATE: Don't ship a truly broken brief.
  // Blocks only if there's NO content at all. Short summaries get a warning,
  // not a block — the archive test is "is there content?", not "is it perfect?".
  // (2026-10-15: the old gate required 3 summaries >200 chars and blocked
  //  100% of sends on Oct 14-15 when the AI produced shorter summaries.)
  const bbCount = (beforeBell || []).length;
  const topCount = (topNews || []).length;
  if (topCount === 0 || bbCount === 0) {
    const reasons = [];
    if (topCount === 0) reasons.push(`top_news=${topCount} (need >0)`);
    if (bbCount === 0) reasons.push(`before_bell=${bbCount} (need >0)`);
    const msg = `[assemble] QUALITY BLOCK for ${runDate}: ${reasons.join("; ")}`;
    console.error(msg);
    throw new QualityBlockedError(msg, { topCount, bbCount, runDate });
  }
  // Warn on short summaries, but don't block the send.
  // Summaries are capped at ~140 chars by capSummary (item #11), so the
  // "substantive" bar is 100 chars, not 200.
  const realSummaries = (topNews || []).filter(
    (s) => s.summary && s.summary.length > 100 && s.summary !== s.headline
  );
  if (realSummaries.length < 3) {
    console.warn(`[assemble] WARNING for ${runDate}: only ${realSummaries.length}/3 substantive summaries (sending anyway)`);
  }

  // Quiet-day detection: fewer than 3 substantial top stories = visibly shorter email.
  // "Quiet morning" is a feature, not a bug — it teaches readers that long = matters.
  const isQuietDay = !topNews || topNews.length < 3;
  const quietNote = isQuietDay
    ? "Quiet morning. When the brief is long, something actually matters."
    : null;

  // Red-day detection: if S&P futures down >1%, acknowledge explicitly.
  // Guidance that vanishes in drawdowns destroys trust. Uses the structured
  // pct on the futures row; falls back to parsing legacy {label, text} rows.
  let redDayNote = null;
  if (beforeBell && beforeBell.length) {
    const spRow =
      beforeBell.find((b) => /s&p/i.test(b.label || "") && /future/i.test(b.label || "")) ||
      beforeBell.find((b) => /s&p/i.test(b.label || ""));
    let pct = spRow && spRow.pct != null ? spRow.pct : null;
    if (pct == null && spRow && spRow.text) {
      const rm = spRow.text.match(/([+-]?[\d.]+)%/);
      if (rm) pct = parseFloat(rm[1]);
    }
    if (pct != null && pct <= -1.0) {
      redDayNote = "Futures are down " + pct.toFixed(2) + "%. Here's what drove it.";
    }
  }

  // ---- GROUPED SEND LOOP ----
  // One grouped claim, one grouped recipient query, one batch Resend call,
  // grouped status updates — no per-user D1 round trips, no per-user POSTs.
  // Suppressed addresses (bounce/complaint, written by
  // functions/api/webhooks/resend.js) are excluded from the send entirely.
  //
  // CRASH-SAFE CLAIMS (2026-10-15): a worker crash between the Resend call
  // and the 'sent' UPDATE used to strand rows at 'sending' forever — the
  // next tick's INSERT OR IGNORE skipped them and the user never got the
  // brief. Every row now carries a claim lease (claimed_at; migration 0002).
  // Before claiming, this tick re-claims stale rows ('sending' with a lease
  // older than 30 min, or NULL for pre-migration rows) and rows a previous
  // tick marked 'failed' (transient Resend errors self-heal on the next
  // tick), stamping them with this tick's claimTs so the pending query below
  // picks them up for retry. Unsubscribed/suppressed users are excluded from
  // the re-claim, exactly like the fresh claim.
  const claimTs = nowSec();
  const STALE_CLAIM_SECS = 30 * 60;
  const reclaimed = await db
    .prepare(
      `UPDATE email_sends SET status = 'sending', sent_at = ?, claimed_at = ?
       WHERE run_date = ?
         AND status IN ('sending', 'failed')
         AND (claimed_at IS NULL OR claimed_at < ?)
         AND user_id IN (
           SELECT id FROM users
           WHERE unsubscribed_at IS NULL
             AND email NOT IN (SELECT email FROM suppressions)
         )`
    )
    .bind(claimTs, claimTs, runDate, claimTs - STALE_CLAIM_SECS)
    .run();
  const reclaimedN =
    reclaimed.meta && typeof reclaimed.meta.changes === "number" ? reclaimed.meta.changes : 0;
  if (reclaimedN > 0) {
    console.log(`[assemble] re-claimed ${reclaimedN} stale/failed send(s) for ${runDate}`);
  }
  const claim = await db
    .prepare(
      `INSERT OR IGNORE INTO email_sends (run_date, user_id, status, sent_at, claimed_at, resend_id)
       SELECT ?, id, 'sending', ?, ?, NULL
       FROM users
       WHERE unsubscribed_at IS NULL
         AND email NOT IN (SELECT email FROM suppressions)`
    )
    .bind(runDate, claimTs, claimTs)
    .run();
  const claimed =
    claim.meta && typeof claim.meta.changes === "number" ? claim.meta.changes : 0;
  console.log(`[assemble] claimed ${claimed} sends for ${runDate} (suppressions excluded)`);

  // All pending sends claimed by THIS tick (sent_at = claimTs) — including
  // stale/failed rows re-claimed above, which were stamped with claimTs and
  // are now retried. Rows still held by another in-flight tick keep their
  // own sent_at and are never double-sent.
  const { results: pending } = await db
    .prepare(
      `SELECT u.id, u.email, u.first_name, u.theme
       FROM users u
       JOIN email_sends e ON e.user_id = u.id
       WHERE e.run_date = ? AND e.status = 'sending' AND e.sent_at = ?
       ORDER BY u.email`
    )
    .bind(runDate, claimTs)
    .all();
  const eligibleRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE unsubscribed_at IS NULL
         AND email NOT IN (SELECT email FROM suppressions)`
    )
    .first();
  const eligible = (eligibleRow && eligibleRow.n) || 0;

  // Subject: "Morning Brief October 14, 2026"
  // Date breaks Gmail threading (new thread every day). Clean, no extras.
  const subject = "Morning Brief " + dateLong;

  // Render one message per recipient. Each gets its own List-Unsubscribe
  // headers (per-recipient token) — preserved by the batch endpoint.
  // NOTE: the per-user user_tickers query is gone — your_stocks has been an
  // empty array since the "no personalization" change; no point reading it.
  const messages = [];
  for (const user of pending) {
    const token = await signToken(user.id, sessionSecret);
    const unsubscribeUrl = `${origin}/api/unsubscribe?token=${token}`;
    const data = {
      first_name: user.first_name,
      date_long: dateLong,
      // The greeting lives in the hidden preheader now (item #9) — the visible
      // block was deleted to make room for the futures strip.
      preheader: `Good morning, ${user.first_name} — here's what matters before the opening bell.`,
      unsubscribe_url: unsubscribeUrl,
      top_news: topNews,
      before_bell: (beforeBell || []).map((b) => {
        // Structured rows {label, level, change, pct, note} from the quotes
        // module; legacy {label, text} rows (mock provider) pass through
        // with the level field empty.
        if (b.level !== undefined) {
          const color = b.pct == null ? "#101418" : b.pct >= 0 ? "#1a7f37" : "#c0392b";
          return {
            label: b.label || "",
            level: b.level || "",
            change: b.change || "",
            color,
            note_display: b.note ? `\u00b7 ${b.note}` : "",
          };
        }
        let text = b.text || "";
        // Strip duplicated label prefix ("S&P 500 S&P 500 -0.06%" -> "-0.06%")
        if (b.label && text.startsWith(b.label)) {
          text = text.slice(b.label.length).trim();
        }
        // Color-code: green for up, red for down
        const color = text.includes("+") ? "#1a7f37" : text.includes("-") ? "#c0392b" : "#101418";
        return { label: b.label || "", level: "", change: text, color, note_display: "" };
      }),
      // Futures strip: big numerals with color-coded % change, under the date.
      futures_strip: (futuresStrip || []).length
        ? (futuresStrip || []).map((f) => ({
            name: f.name || "",
            level: f.level || "",
            pct: f.pct == null ? "" : `${f.pct >= 0 ? "+" : ""}${f.pct.toFixed(2)}%`,
            color: f.pct == null ? "#101418" : f.pct >= 0 ? "#1a7f37" : "#c0392b",
          }))
        : null,
      // Overnight block: one compact line ("Nikkei 225 -1.2% · ...").
      overnight_line: overnightLine || null,
      // Null (not []) when empty so {{#if premarket_movers}} hides the block
      // ([] is truthy in JS — the futures_strip block uses the same convention).
      premarket_movers: (premarketMovers || []).length
        ? (premarketMovers || []).map((m) => ({
            ...m,
            color:
              m.direction === "up" ? "#1a7f37" : m.direction === "down" ? "#c0392b" : "#101418",
          }))
        : null,
      picture: picture,
      your_stocks: [],
      stocks_to_watch: marketSection(briefRows, runDate, "stocks_to_watch"),
      calendar_earnings: calendar.earnings || [],
      calendar_econ: calendar.econ || [],
      quiet_note: quietNote,
      day_take: dayTake || null,
      red_day_note: redDayNote,
    };
    const html = renderTemplate(templateText, data, { theme: user.theme === "dark" ? "dark" : "light" });
    const text = buildTextVersion({
      productName,
      dateLong,
      firstName: user.first_name,
      topNews,
      beforeBell,
      futuresStrip,
      overnightLine,
      yourStocks: [],
      stocksToWatch: marketSection(briefRows, runDate, "stocks_to_watch"),
      calendar,
      premarketMovers,
    });
    messages.push({
      id: user.id,
      email: user.email,
      to: user.email,
      subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  }

  const okEntries = []; // [{id, resendId}] — resendId = Resend message id (audit/de-dupe)
  const failIds = [];
  // Batch first (Resend /emails/batch, per-recipient headers preserved),
  // serial fallback on any batch failure. Senders without sendBatch
  // (FileOutboxSender, test doubles) always go serial.
  let usedBatch = false;
  if (typeof sender.sendBatch === "function" && messages.length > 0) {
    try {
      const results = await sender.sendBatch(messages);
      usedBatch = true;
      for (let i = 0; i < messages.length; i++) {
        const r = results && results[i];
        if (r && r.ok) okEntries.push({ id: messages[i].id, resendId: r.id || null });
        else failIds.push(messages[i].id);
      }
      console.log(`[assemble] batch sent ${okEntries.length}/${messages.length} for ${runDate}`);
    } catch (e) {
      console.error(`[assemble] batch send failed, falling back to serial: ${e.message}`);
    }
  }
  if (!usedBatch) {
    for (const msg of messages) {
      try {
        const res = await sender.send(msg);
        if (res && res.ok === false) {
          console.error(`[assemble] send to ${msg.email}: failed (status ${res.status})`);
          failIds.push(msg.id);
        } else {
          okEntries.push({ id: msg.id, resendId: (res && res.id) || null });
        }
      } catch (e) {
        console.error(`[assemble] send to ${msg.email}: ${e.message}`);
        failIds.push(msg.id);
      }
    }
  }

  // Grouped status updates (one query per outcome, chunked for D1's
  // 100-variable bind limit — not one UPDATE per user).
  await markSent(db, runDate, claimTs, okEntries, nowSec);
  await markSends(db, runDate, claimTs, "failed", failIds, nowSec);
  return { sent: okEntries.length, skipped: eligible - pending.length, users: pending.length };
}

/** Grouped 'sent' update that also stores each row's Resend message id.
 *  Per-row resend_id values need a CASE expression; chunked to 30 users so
 *  the bind count stays under D1's 100-variable limit
 *  (1 + 2*30 sent_at/case-binds + 3 + 30 IN-list = 94). */
async function markSent(db, runDate, claimTs, entries, nowSec) {
  for (let i = 0; i < entries.length; i += 30) {
    const chunk = entries.slice(i, i + 30);
    const whenThen = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const ph = chunk.map(() => "?").join(",");
    const ids = chunk.map((e) => e.id);
    await db
      .prepare(
        `UPDATE email_sends SET status = 'sent', sent_at = ?,
           resend_id = CASE user_id ${whenThen} ELSE NULL END
         WHERE run_date = ? AND status = 'sending' AND sent_at = ? AND user_id IN (${ph})`
      )
      .bind(
        nowSec(),
        ...chunk.flatMap((e) => [e.id, e.resendId || null]),
        runDate,
        claimTs,
        ...ids
      )
      .run();
  }
}

/** Grouped status update for the send loop: sets status for a set of claimed
 *  (run_date, user_id) rows in one statement per <=100-id chunk. */
async function markSends(db, runDate, claimTs, status, userIds, nowSec) {
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100);
    const ph = chunk.map(() => "?").join(",");
    await db
      .prepare(
        `UPDATE email_sends SET status = ?, sent_at = ?
         WHERE run_date = ? AND status = 'sending' AND sent_at = ? AND user_id IN (${ph})`
      )
      .bind(status, nowSec(), runDate, claimTs, ...chunk)
      .run();
  }
}

/** Idempotent stage runner for the worker: claims (run_date, stage) once.
 *
 *  Statuses:
 *    'done'    — stage completed successfully
 *    'failed'  — stage threw an unexpected error (will alert)
 *    'blocked' — stage ran but quality gate blocked it (QualityBlockedError).
 *                Distinct from 'failed': the code worked, the data wasn't shippable.
 *                The next tick will retry (blocked != done).
 */
export async function runStage(db, runDate, stage, fn, nowSec) {
  const existing = await db
    .prepare("SELECT status FROM pipeline_runs WHERE run_date = ? AND stage = ?")
    .bind(runDate, stage)
    .first();
  if (existing && existing.status === "done") return { alreadyDone: true };
  await db
    .prepare(
      `INSERT OR REPLACE INTO pipeline_runs (run_date, stage, status, detail, started_at, finished_at)
       VALUES (?, ?, 'started', '', ?, NULL)`
    )
    .bind(runDate, stage, nowSec())
    .run();
  try {
    const result = await fn();
    await db
      .prepare(
        `UPDATE pipeline_runs SET status = 'done', detail = ?, finished_at = ? WHERE run_date = ? AND stage = ?`
      )
      .bind(JSON.stringify(result || {}).slice(0, 2000), nowSec(), runDate, stage)
      .run();
    return { alreadyDone: false, result };
  } catch (e) {
    const status = e instanceof QualityBlockedError ? "blocked" : "failed";
    await db
      .prepare(
        `UPDATE pipeline_runs SET status = ?, detail = ?, finished_at = ? WHERE run_date = ? AND stage = ?`
      )
      .bind(status, String(e.message).slice(0, 2000), nowSec(), runDate, stage)
      .run();
    // Quality blocks are expected operational events, not crashes.
    // Log loudly but don't rethrow — the tick continues and will retry next hour.
    // Unexpected errors still throw so they surface in worker logs.
    if (e instanceof QualityBlockedError) {
      console.error(`[runStage] ${stage} BLOCKED for ${runDate} (will retry next tick)`);
      return { alreadyDone: false, blocked: true, error: e.message };
    }
    throw e;
  }
}
function buildTextVersion({ productName, dateLong, topNews, beforeBell, futuresStrip, overnightLine, premarketMovers, yourStocks, stocksToWatch, calendar }) {
  const bbLine = (s) => {
    // Structured rows {label, level, change, pct, note}; legacy {label, text}.
    if (s.level !== undefined) {
      const bits = [s.label, s.level, s.change].filter(Boolean).join(" ");
      return `- ${bits}${s.note ? ` (${s.note})` : ""}`;
    }
    let text = s.text || "";
    if (s.label && text.startsWith(s.label)) text = text.slice(s.label.length).trim();
    return `- ${s.label}: ${text}`;
  };
  const lines = [
    `${productName} — ${dateLong}`,
    "",
    ...((futuresStrip || []).length > 0
      ? [
          "FUTURES",
          ...futuresStrip.map((f) => `- ${f.name} futures: ${f.level} (${f.pct >= 0 ? "+" : ""}${(f.pct || 0).toFixed(2)}%)`),
          "",
        ]
      : []),
    "BEFORE THE BELL",
    ...beforeBell.flatMap((s) => [bbLine(s)]),
    ...(overnightLine ? [`Overnight: ${overnightLine}`, ""] : [""]),
    "PRE-MARKET MOVERS",
    ...((premarketMovers || []).length > 0
      ? premarketMovers.map((m) => `- ${m.ticker} (${m.company}): ${m.change_text}${m.reason ? ` — ${m.reason}` : ""}`)
      : ["- No S&P 500 pre-market movers data."]),
    "",
    "TOP NEWS",
    ...topNews.flatMap((s) => [`- ${s.headline}`, `  ${s.summary}`, ""]),
    "STOCKS TO WATCH",
    ...((stocksToWatch || []).length > 0
      ? stocksToWatch.flatMap((s) => [`- ${s.ticker} (${s.company})`, `  ${s.reason}`, ""])
      : ["- No specific catalysts today."]),
    "",
    ...(yourStocks.length > 0
      ? ["YOUR STOCKS", ...yourStocks.flatMap((s) => [`- ${s.ticker} (${s.company})`, `  ${s.summary}`, ""])]
      : []),
    "TODAY'S CALENDAR",
    "Earnings:",
    ...calendar.earnings.map((e) => {
      const detail = e.earnings_detail ? ` — ${e.earnings_detail}` : "";
      return `- ${e.ticker} (${e.company}) — ${e.time}${detail}`;
    }),
    "Economic releases:",
    ...calendar.econ.map((e) => `- ${e.time_et}: ${e.event}`),
    "",
    "For informational purposes only. Not investment advice.",
  ];
  return lines.join("\n");
}

/**
 * Assemble + send one personalized email per subscribed user.
 * Idempotent via email_sends(run_date, user_id). Users with no tickers or no
 * ticker news still get the market overview (their YOUR STOCKS section is empty
 * and the template drops it).
 *
 * Crash-safe claims: each tick stamps its claims with claimTs; before
 * claiming, stale 'sending' rows (lease >30 min old, or pre-migration NULL)
 * and 'failed' rows from earlier ticks are re-claimed and retried, so a
 * worker crash between the Resend call and the 'sent' UPDATE can't strand a
 * user. Successful sends store the Resend message id in resend_id.
 */
