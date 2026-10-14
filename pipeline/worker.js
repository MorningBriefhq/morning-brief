// Morning Brief — clean pipeline worker.
//
// Architecture (lessons learned 2026-10-13):
// - Step-based, not time-based: each hourly tick runs the next unfinished step.
// - No personalization: one editorial brief for everyone.
// - Market stage does news + AI summaries (slow); gets its own step.
// - Assemble only sends during 6-10 AM ET window.
//
// Steps:
//   1. ingest  — fetch and store raw news (fast)
//   2. market  — generate AI summaries, stocks to watch (slow)
//   3. assemble — build email and send (6-10 AM ET only)

import { runDateET, etHour, dateLongET, addDaysET } from "./lib/time.js";
import { MultiSourceNewsProvider } from "./lib/news-multi.js";
import { WorkersAISummarizer, MockSummarizer } from "./lib/summarize.js";
import { FinnhubMarketProvider } from "./lib/market-finnhub.js";
import { ResendSender } from "./lib/send.js";
import { runMarket, runAssemble, runStage } from "./stages.js";
import templateText from "./email-template.js";

const nowSec = () => Math.floor(Date.now() / 1000);

function buildProviders(env) {
  const news = new MultiSourceNewsProvider({
    marketauxKey: env.MARKETAUX_API_KEY,
    guardianKey: env.GUARDIAN_API_KEY,
    finnhubKey: env.FINNHUB_API_KEY,
  });
  const summarizer = env.AI
    ? new WorkersAISummarizer(env.AI, env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct")
    : new MockSummarizer();
  const market = new FinnhubMarketProvider({
    finnhubKey: env.FINNHUB_API_KEY,
    fmpKey: env.FMP_API_KEY,
    fredKey: env.FRED_API_KEY,
  });
  const sender = env.RESEND_API_KEY
    ? new ResendSender(env.RESEND_API_KEY, env.BRIEFING_FROM || "briefing@morningbrief.link")
    : null;
  return { news, summarizer, market, sender };
}

async function runIngestStage(env, runDate) {
  const db = env.DB;
  await runStage(db, runDate, "ingest", async () => {
    // Ingest is a no-op now — market stage fetches directly.
    // Kept as a step for pipeline ordering.
    return { ok: true };
  }, nowSec);
}

async function runMarketStage(env, runDate) {
  const db = env.DB;
  const { news, summarizer, market } = buildProviders(env);
  await runStage(db, runDate, "market", async () => {
    return runMarket({ db, market, news, runDate, nowSec: nowSec, summarizer });
  }, nowSec);
}

// Admin auth: ADMIN_KEY must be set as a worker secret
// (wrangler secret put ADMIN_KEY). Pass it as an x-admin-key header,
// a Bearer token, or the ?key= query param. Fails closed when unset.
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

async function runAssembleStage(env, runDate) {
  const db = env.DB;
  const { sender } = buildProviders(env);
  if (!sender) {
    console.error("[assemble] no sender configured");
    return null;
  }
  const productName = env.PRODUCT_NAME || "Morning Brief";
  const origin = env.PUBLIC_ORIGIN || "https://morningbrief.link";
  let result = null;
  await runStage(db, runDate, "assemble", async () => {
    result = await runAssemble({
      db, sender, runDate,
      dateLong: dateLongET(new Date()),
      origin, productName,
      sessionSecret: env.SESSION_SECRET || "dev-secret",
      templateText,
      nowSec: nowSec,
    });
    return result;
  }, nowSec);
  return result;
}

export default {
  async scheduled(_event, env, _ctx) {
    const now = new Date();
    const runDate = runDateET(now);
    const db = env.DB;

    // Step-based: run the next unfinished step.
    const { results: stages } = await db.prepare(
      "SELECT stage, status FROM pipeline_runs WHERE run_date = ?"
    ).bind(runDate).all();
    const done = new Set(stages.filter((s) => s.status === "done").map((s) => s.stage));

    if (!done.has("ingest")) {
      await runIngestStage(env, runDate);
      return;
    }
    if (!done.has("market")) {
      await runMarketStage(env, runDate);
      return;
    }
    // Assemble only during morning window (6-10 AM ET)
    const hour = etHour(now);
    if (!done.has("assemble") && hour >= 6 && hour <= 10) {
      await runAssembleStage(env, runDate);
      return;
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }

    // Pipeline status (for monitoring) — admin auth required
    if (url.pathname === "/admin/status") {
      if (!isAdminAuthorized(request, env)) {
        return new Response("unauthorized", { status: 401 });
      }      const runDate = runDateET(new Date());
      const { results: stages } = await env.DB.prepare(
        "SELECT stage, status, started_at, finished_at FROM pipeline_runs WHERE run_date = ? ORDER BY started_at"
      ).bind(runDate).all();
      const { results: sends } = await env.DB.prepare(
        "SELECT status, COUNT(*) as n FROM email_sends WHERE run_date = ? GROUP BY status"
      ).bind(runDate).all();
      return Response.json({ runDate, stages, sends });
    }

    // Public market snapshot for website
    if (url.pathname === "/api/snapshot") {
      const { market } = buildProviders(env);
      try {
        const data = await market.snapshot();
        return Response.json(data);
      } catch (e) {
        return Response.json({ error: e.message }, 500);
      }
    }

    return new Response("not found", { status: 404 });
  },
};
