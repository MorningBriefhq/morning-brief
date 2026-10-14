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
import { truncateWords } from "./lib/summarize.js";
import { fetchEconCalendar } from "./lib/econ.js";
import { fetchRecent8Ks } from "./lib/edgar.js";

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
 * Build the calendar section: earnings from Finnhub/FMP, econ from FXMacroData.
 *
 * Finnhub's /calendar/econ returned empty on 2026-10-14, so FXMacroData
 * (free, no key, official release calendars) is the primary econ source.
 * Finnhub econ is kept as a supplement when it has data.
 */
async function buildCalendar(market, runDate) {
  const out = { earnings: [], econ: [] };
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
  return out;
}

export async function runMarket({ db, market, news, runDate, nowSec, summarizer = null }) {
  // Use the multi-source news provider (Marketaux + Guardian + RSS) for Top News.
  // Falls back to market.topNews (Finnhub) if no news provider.
  let userTickers = [];
  try {
    const { results } = await db
      .prepare("SELECT DISTINCT ticker FROM user_tickers")
      .all();
    userTickers = results.map((r) => r.ticker);
  } catch {}
  const topNews = news && typeof news.topNews === "function"
    ? await news.topNews(null, null, 8)
    : await market.topNews(runDate);
  const mergers = typeof market.mergers === "function" ? await market.mergers(runDate) : [];

  // Enrich stories with synthesized summaries from MULTIPLE sources.
  // We pool Marketaux, Guardian, RSS — the AI synthesizes into our own voice.
  // Skip URL scraping (too slow); use API-provided text only.
  // If AI fails for a story, fall back to extractive so we never ship "".
  let aiFailures = 0;
  let aiAttempts = 0;
  if (summarizer && typeof summarizer.summarizeStory === "function") {
    for (const stories of [topNews, mergers]) {
      for (const s of stories) {
        try {
          // Use API-provided text only — no slow URL scraping
          const sources = [];
          if (s.summary) sources.push({ source: "summary", text: s.summary.slice(0, 1500) });
          if (s.fullText) sources.push({ source: "full-text", text: s.fullText.slice(0, 2000) });
          if (sources.length === 0) continue;
          aiAttempts++;
          const raw = await summarizer.summarizeStory(s.headline, sources);
          s.summary = truncateWords(raw, 150);
        } catch (e) {
          aiFailures++;
          console.error("[market] story summary failed:", e.message);
          // Extractive fallback — never leave summary empty
          const fallback = extractiveSummary(s);
          if (fallback) s.summary = fallback;
        }
      }
    }
  }
  if (aiAttempts > 0 && aiFailures === aiAttempts) {
    console.error(`[market] ALL ${aiAttempts} AI summaries failed for ${runDate} — check Workers AI binding/model. Using extractive fallbacks.`);
  }

  const sections = {
    top_news: topNews,
    before_bell: await market.beforeBell(runDate),
    treasury_yields: typeof market.treasuryYields === "function" ? await market.treasuryYields() : null,
    calendar: await buildCalendar(market, runDate),
    mergers: mergers,
    analysts: typeof market.analysts === "function" ? await market.analysts(runDate, userTickers) : [],
    picture: typeof market.pictureOfTheDay === "function" ? await market.pictureOfTheDay(topNews, summarizer) : null,
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
  // Based on top news, analyst moves, and upcoming earnings. Our editorial voice.
  if (summarizer && typeof summarizer.summarizeStory === "function" && topNews.length >= 3) {
    try {
      const newsContext = topNews.slice(0, 8).map((s, i) => `${i + 1}. ${s.headline}: ${(s.summary || "").slice(0, 200)}`).join("\n");
      const analystContext = (sections.analysts || []).slice(0, 5).map((a) => `- ${a.headline}`).join("\n");
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
        `Base picks on the news, analyst actions, and earnings below. Favor S&P 500 companies. ` +
        `No investment advice. Format as a JSON array: [{"ticker": "AVGO", "company": "Broadcom", "reason": "..."}, ...]\n\n` +
        `Top news:\n${newsContext}\n\nAnalyst moves:\n${analystContext || "(none)"}\n\nEarnings:\n${earningsContext || "(none)"}\n\nSEC 8-K filings (authoritative corporate actions):\n${eightKContext || "(none)"}`;

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
      const bb = (sections.before_bell || []).map((b) => `${b.label}: ${b.text}`).join("; ");
      const thesisPrompt =
        `Give a neutral, substantive take on today's market setup for a morning investor briefing. ` +
        `Name the 1-2 dominant themes driving markets this morning. State what matters and why, not predictions. ` +
        `Get the key points across — as long as they need, as short as they can be. Facts only from the headlines below. No investment advice.\n\n` +
        `Overnight market data: ${bb}\n\nTop stories:\n${headlines}`;
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
  const { results: users } = await db
    .prepare("SELECT id, email, first_name, theme FROM users WHERE unsubscribed_at IS NULL ORDER BY email")
    .all();
  const { results: briefRows } = await db
    .prepare("SELECT section, payload FROM market_briefs WHERE run_date = ?")
    .bind(runDate)
    .all();

  const topNews = marketSection(briefRows, runDate, "top_news");
  const beforeBell = marketSection(briefRows, runDate, "before_bell");
  const calendar = marketSection(briefRows, runDate, "calendar");
  const mergers = marketSection(briefRows, runDate, "mergers");
  const analysts = marketSection(briefRows, runDate, "analysts");
  const picture = marketSection(briefRows, runDate, "picture");
  const dayTake = marketSection(briefRows, runDate, "day_take");

  // QUALITY GATE: Don't ship a bad brief. Every story must have a real summary.
  // Better to send late than send garbage.
  //
  // On block: throws QualityBlockedError with specifics. This is LOUD —
  // logged with exact counts, recorded as status='blocked' in pipeline_runs,
  // and rethrown so the tick handler sees it. Never silently 'done'.
  const realSummaries = (topNews || []).filter(
    (s) => s.summary && s.summary.length > 200 && s.summary !== s.headline
  );
  const bbCount = (beforeBell || []).length;
  const topCount = (topNews || []).length;
  const realCount = realSummaries.length;
  // Need at least 3 substantive stories, and before_bell must have content
  if (topCount < 3 || realCount < 3 || bbCount === 0) {
    const reasons = [];
    if (topCount < 3) reasons.push(`top_news=${topCount} (need >=3)`);
    if (realCount < 3) reasons.push(`real_summaries=${realCount} (need >=3, summary>200 chars, != headline)`);
    if (bbCount === 0) reasons.push(`before_bell=${bbCount} (need >0)`);
    const msg = `[assemble] QUALITY BLOCK for ${runDate}: ${reasons.join("; ")}`;
    console.error(msg);
    console.error(`[assemble] top_news headlines: ${(topNews || []).map(s => s.headline?.slice(0, 60)).join(" | ") || "(none)"}`);
    throw new QualityBlockedError(msg, { topCount, realCount, bbCount, runDate });
  }

  // Quiet-day detection: fewer than 3 substantial top stories = visibly shorter email.
  // "Quiet morning" is a feature, not a bug — it teaches readers that long = matters.
  const isQuietDay = !topNews || topNews.length < 3;
  const quietNote = isQuietDay
    ? "Quiet morning. When the brief is long, something actually matters."
    : null;

  // Red-day detection: if S&P futures down >1%, acknowledge explicitly.
  // Guidance that vanishes in drawdowns destroys trust.
  let redDayNote = null;
  if (beforeBell && beforeBell.length) {
    var spb = beforeBell.find(function (b) { return /s&p/i.test(b.label || ""); });
    if (spb && spb.text) {
      var rm = spb.text.match(/([+-]?[\d.]+)%/);
      if (rm && parseFloat(rm[1]) <= -1.0) {
        redDayNote = "Futures are down " + rm[1] + "%. Here's what drove it.";
      }
    }
  }

  let sent = 0;
  let skipped = 0;
  for (const user of users) {
    // ATOMIC CLAIM: insert first, send only if we won the race.
    // INSERT OR IGNORE returns changes=1 only for the first claimer.
    const claim = await db
      .prepare(
        `INSERT OR IGNORE INTO email_sends (run_date, user_id, status, sent_at)
         VALUES (?, ?, 'sending', ?)`
      )
      .bind(runDate, user.id, nowSec())
      .run();
    if (claim.meta.changes === 0) {
      skipped++;
      continue;
    }

    const { results: tickers } = await db
      .prepare("SELECT ticker FROM user_tickers WHERE user_id = ? ORDER BY ticker")
      .bind(user.id)
      .all();

    // No personalization — one brief for everyone. yourStocks stays empty.
    let yourStocks = [];

    const token = await signToken(user.id, sessionSecret);
    const unsubscribeUrl = `${origin}/api/unsubscribe?token=${token}`;
    const preheader = `Top news, markets, and today's calendar — ${dateLong}`;

    const data = {
      first_name: user.first_name,
      date_long: dateLong,
      preheader,
      unsubscribe_url: unsubscribeUrl,
      top_news: topNews,
      before_bell: (beforeBell || []).map((b) => {
        let text = b.text || "";
        // Strip duplicated label prefix ("S&P 500 S&P 500 -0.06%" -> "-0.06%")
        if (b.label && text.startsWith(b.label)) {
          text = text.slice(b.label.length).trim();
        }
        // Color-code: green for up, red for down
        const color = text.includes("+") ? "#1a7f37" : text.includes("-") ? "#c0392b" : "#101418";
        return { ...b, text, color };
      }),
      mergers: mergers,
      analysts: analysts,
      picture: picture,
      your_stocks: yourStocks,
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
      mergers,
      analysts,
      yourStocks,
      stocksToWatch: marketSection(briefRows, runDate, "stocks_to_watch"),
      calendar,
    });
    // Subject: "Morning Brief October 14, 2026"
    // Date breaks Gmail threading (new thread every day). Clean, no extras.
    var subject = "Morning Brief " + dateLong;

    let status = "sent";
    try {
      const res = await sender.send({ to: user.email, subject, html, text });
      if (res && res.ok === false) status = "failed";
    } catch (e) {
      console.error(`[assemble] send to ${user.email}: ${e.message}`);
      status = "failed";
    }
    await db
      .prepare(
        `UPDATE email_sends SET status = ?, sent_at = ?
         WHERE run_date = ? AND user_id = ?`
      )
      .bind(status, nowSec(), runDate, user.id)
      .run();
    if (status === "sent") sent++;
  }
  return { sent, skipped, users: users.length };
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
function buildTextVersion({ productName, dateLong, firstName, topNews, beforeBell, mergers, analysts, yourStocks, stocksToWatch, calendar }) {
  const lines = [
    `${productName} — ${dateLong}`,
    `Good morning, ${firstName} — here's what matters before the opening bell.`,
    "",
    "TOP NEWS",
    ...topNews.flatMap((s) => [`- ${s.headline}`, `  ${s.summary}`, ""]),
    "BEFORE THE BELL",
    ...beforeBell.flatMap((s) => {
      let text = s.text || "";
      if (s.label && text.startsWith(s.label)) text = text.slice(s.label.length).trim();
      return [`- ${s.label}: ${text}`];
    }),
    "",
    "MERGERS & ACQUISITIONS",
    ...(mergers.length > 0
      ? mergers.flatMap((s) => [`- ${s.headline}`, `  ${s.summary}`, ""])
      : ["- No major deals announced."]),
    "",
    "ANALYST MOVES",
    ...(analysts.length > 0
      ? analysts.flatMap((s) => [`- ${s.headline}`, `  ${s.summary}`, ""])
      : ["- No notable upgrades or downgrades."]),
    "",
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
    ...calendar.earnings.map((e) => `- ${e.ticker} (${e.company}) — ${e.time}`),
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
 */
