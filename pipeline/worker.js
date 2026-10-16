// Morning Brief — pipeline worker (rebuild 2026-10-14).
//
// Architecture:
// - Stage chaining: a single tick can run ingest → market → assemble in sequence.
//   No more one-stage-per-tick. If the tick starts at 9:55 AM ET, all stages
//   complete before the 10 AM window closes.
// - Startup validation: every expected secret is checked and logged.
// - Loud failures: quality blocks and errors are logged with context and
//   recorded as 'blocked'/'failed' — never silently 'done'.
// - Idempotent stages: safe to re-run for the same run_date.
//
// Stages:
//   1. ingest  — fetch and store raw news (fast, runs any hour)
//   2. market  — generate AI summaries, stocks to watch (slow, runs any hour)
//   3. assemble — build email and send (6-10 AM ET window only)
//
// Cron: hourly (`0 * * * *`). Send window: 6-10 AM ET inclusive.

import { runDateET, etHour, dateLongET } from "./lib/time.js";
import { MultiSourceNewsProvider } from "./lib/news-multi.js";
import { WorkersAISummarizer, MockSummarizer } from "./lib/summarize.js";
import { FinnhubMarketProvider } from "./lib/market-finnhub.js";
import { ResendSender } from "./lib/send.js";
import { SP500 } from "./lib/sp500.js";
import { runMarket, runAssemble, runStage } from "./stages.js";
import templateText from "./email-template.js";

const nowSec = () => Math.floor(Date.now() / 1000);

const SEND_WINDOW_START = 6;  // 6 AM ET
const SEND_WINDOW_END = 10;    // 10 AM ET

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------
// Critical: pipeline cannot function without these.
// Degraded: pipeline runs but with reduced capability (logged loudly).
// Optional: has a sane default.

const EXPECTED_SECRETS = [
  // [envKey, level, description]
  ["FINNHUB_API_KEY",    "critical", "market data (quotes, earnings calendar, news)"],
  ["FMP_API_KEY",        "degraded", "Financial Modeling Prep (backup market data)"],
  ["MARKETAUX_API_KEY",  "critical", "primary news API"],
  ["GUARDIAN_API_KEY",   "degraded", "Guardian news (deep-dive articles)"],
  ["RESEND_API_KEY",     "critical", "email sending"],
  ["SESSION_SECRET",     "critical", "magic-link signing (must match Pages)"],
  ["ADMIN_KEY",          "critical", "/admin/status auth"],
  ["UNSPLASH_ACCESS_KEY","degraded", "picture-of-the-day images"],
  ["FRED_API_KEY",       "degraded", "treasury yield data"],
  ["ALPHA_VANTAGE_API_KEY", "degraded", "Alpha Vantage (earnings calendar fallback, news sentiment)"],
  ["BRIEFING_FROM",      "optional", "sender address (default: briefing@morningbrief.link)"],
  ["PRODUCT_NAME",       "optional", "product name (default: Morning Brief)"],
  ["PUBLIC_ORIGIN",      "optional", "site URL (default: https://morningbrief.link)"],
  ["WORKERS_AI_MODEL",   "optional", "Workers AI model override"],
];

function validateEnv(env) {
  const missing = { critical: [], degraded: [], optional: [] };
  for (const [key, level] of EXPECTED_SECRETS) {
    if (!env[key]) missing[level].push(key);
  }
  // Bindings
  const bindings = {
    DB: !!env.DB,
    AI: !!env.AI,
  };
  if (!bindings.DB) missing.critical.push("DB (D1 binding)");
  if (!bindings.AI) {
    console.warn("[startup] AI binding missing — using MockSummarizer (no AI summaries)");
  }

  if (missing.critical.length > 0) {
    console.error(`[startup] CRITICAL secrets missing: ${missing.critical.join(", ")}`);
  }
  if (missing.degraded.length > 0) {
    console.warn(`[startup] Degraded capability — missing: ${missing.degraded.join(", ")}`);
  }
  const presentCount = EXPECTED_SECRETS.length - missing.critical.length - missing.degraded.length - missing.optional.length;
  console.log(`[startup] Secrets: ${presentCount}/${EXPECTED_SECRETS.length} present. ` +
    `Critical missing: ${missing.critical.length}, degraded: ${missing.degraded.length}.`);
  return missing;
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------
// Constructor signatures (audited 2026-10-14):
//   FinnhubMarketProvider(apiKey, fmpKey, sp500list, unsplashKey, fredKey)
//   MultiSourceNewsProvider({ marketauxKey, guardianKey, finnhubProvider, alphavantageKey })
//   WorkersAISummarizer(aiBinding, model)
//   MockSummarizer()
//   ResendSender(apiKey, from)

function buildProviders(env) {
  // Market provider first — news provider takes it as a fallback instance.
  const market = new FinnhubMarketProvider(
    env.FINNHUB_API_KEY || null,
    env.FMP_API_KEY || null,
    SP500,
    env.UNSPLASH_ACCESS_KEY || null,
    env.FRED_API_KEY || null
  );
  // (avKey was formerly attached here for the beforeBell() index-quote
  // fallback; removed 2026-10-15 — beforeBell now uses the keyless quotes
  // module (stooq.js) with no ETF proxies. Alpha Vantage still flows to the
  // news provider and runMarket for the earnings calendar.)
  const news = new MultiSourceNewsProvider({
    marketauxKey: env.MARKETAUX_API_KEY || null,
    guardianKey: env.GUARDIAN_API_KEY || null,
    finnhubProvider: market,
    alphavantageKey: env.ALPHA_VANTAGE_API_KEY || null,
  });
  const summarizer = env.AI
    ? new WorkersAISummarizer(env.AI, "@cf/meta/llama-3.2-3b-instruct")
    : new MockSummarizer();
  const sender = env.RESEND_API_KEY
    ? new ResendSender(env.RESEND_API_KEY, env.BRIEFING_FROM || "briefing@morningbrief.link")
    : null;
  return { news, summarizer, market, sender };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function runIngestStage(env, runDate) {
  const db = env.DB;
  return runStage(db, runDate, "ingest", async () => {
    // Ingest is a no-op — market stage fetches directly.
    // Kept as a step for pipeline ordering and future use.
    return { ok: true, note: "ingest is a no-op; market fetches directly" };
  }, nowSec);
}

async function runMarketStage(env, runDate) {
  const db = env.DB;
  const { news, summarizer, market } = buildProviders(env);
  return runStage(db, runDate, "market", async () => {
    return runMarket({ db, market, news, runDate, nowSec, summarizer, alphavantageKey: env.ALPHA_VANTAGE_API_KEY || null });
  }, nowSec);
}

async function runAssembleStage(env, runDate) {
  const db = env.DB;
  const { sender } = buildProviders(env);
  if (!sender) {
    throw new Error(
      "[assemble] RESEND_API_KEY is not set. Cannot send email. " +
      "Set it via `wrangler secret put RESEND_API_KEY --config pipeline/wrangler.toml`."
    );
  }
  const productName = env.PRODUCT_NAME || "Morning Brief";
  const origin = env.PUBLIC_ORIGIN || "https://morningbrief.link";
  if (!env.SESSION_SECRET) {
    throw new Error(
      "[assemble] SESSION_SECRET is not set. Set it via " +
      "`wrangler secret put SESSION_SECRET --config pipeline/wrangler.toml` " +
      "(must match the Pages project's SESSION_SECRET)."
    );
  }
  let result = null;
  await runStage(db, runDate, "assemble", async () => {
    result = await runAssemble({
      db, sender, runDate,
      dateLong: dateLongET(new Date()),
      origin, productName,
      sessionSecret: env.SESSION_SECRET,
      templateText,
      nowSec,
    });
    return result;
  }, nowSec);
  return result;
}

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------

function isAdminAuthorized(request, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const url = new URL(request.url);
  const provided =
    request.headers.get("x-admin-key") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key");
  return provided === key;
}

// ---------------------------------------------------------------------------
// Scheduled handler — CHAINED stages
// ---------------------------------------------------------------------------
// A single tick progresses through ALL unfinished stages in order.
// No early returns: if ingest finishes at 9:55 AM, market and assemble
// still run in the same tick before the window closes.

export default {
  async scheduled(_event, env, _ctx) {
    const now = new Date();
    const runDate = runDateET(now);
    const hour = etHour(now);
    const db = env.DB;

    console.log(`[tick] ${now.toISOString()} run_date=${runDate} et_hour=${hour}`);

    // Validate on every tick (cheap, catches secret rotation issues fast).
    const missing = validateEnv(env);
    if (missing.critical.includes("DB (D1 binding)")) {
      console.error("[tick] D1 binding missing — aborting tick");
      return;
    }

    const readDone = async () => {
      const { results: stages } = await db.prepare(
        "SELECT stage, status FROM pipeline_runs WHERE run_date = ?"
      ).bind(runDate).all();
      return new Set(stages.filter((s) => s.status === "done").map((s) => s.stage));
    };

    let done = await readDone();

    // Stage 1: ingest (any hour)
    if (!done.has("ingest")) {
      console.log(`[tick] running ingest for ${runDate}`);
      await runIngestStage(env, runDate);
      done = await readDone();
    }

    // Stage 2: market (any hour)
    if (!done.has("market")) {
      console.log(`[tick] running market for ${runDate}`);
      const marketResult = await runMarketStage(env, runDate);
      done = await readDone();
      if (marketResult && marketResult.alreadyDone) {
        console.log(`[tick] market already done for ${runDate}`);
      }
    }

    // Stage 3: assemble (send window only: 6-10 AM ET)
    const inWindow = hour >= SEND_WINDOW_START && hour <= SEND_WINDOW_END;
    if (!done.has("assemble")) {
      if (!inWindow) {
        console.log(`[tick] assemble pending for ${runDate} but outside send window (et_hour=${hour}, window=${SEND_WINDOW_START}-${SEND_WINDOW_END})`);
      } else {
        // Re-check critical secrets before sending.
        if (!env.RESEND_API_KEY) {
          console.error(`[tick] assemble blocked for ${runDate}: RESEND_API_KEY missing`);
        } else if (!env.SESSION_SECRET) {
          console.error(`[tick] assemble blocked for ${runDate}: SESSION_SECRET missing`);
        } else {
          console.log(`[tick] running assemble for ${runDate} (in send window)`);
          await runAssembleStage(env, runDate);
          done = await readDone();
        }
      }
    }

    console.log(`[tick] done for ${runDate}. stages: ${[...done].join(",") || "(none)"}`);
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }

    // Pipeline status (for monitoring) — admin auth required
    if (url.pathname === "/admin/status") {
      if (!isAdminAuthorized(request, env)) {
        return new Response("unauthorized", { status: 401 });
      }
      const runDate = runDateET(new Date());
      const { results: stages } = await env.DB.prepare(
        "SELECT stage, status, started_at, finished_at, detail FROM pipeline_runs WHERE run_date = ? ORDER BY started_at"
      ).bind(runDate).all();
      const { results: sends } = await env.DB.prepare(
        "SELECT status, COUNT(*) as n FROM email_sends WHERE run_date = ? GROUP BY status"
      ).bind(runDate).all();
      // Active subscriber count — lets the Sentinel dead-man check verify
      // that sent count roughly matches the audience (outcome-based, not
      // just endpoint-based monitoring).
      const subRow = await env.DB.prepare(
        "SELECT COUNT(*) as n FROM users WHERE unsubscribed_at IS NULL"
      ).first();
      return Response.json({
        runDate,
        stages,
        sends,
        active_subscribers: (subRow && subRow.n) || 0,
      });
    }

    return new Response("not found", { status: 404 });
  },
};
