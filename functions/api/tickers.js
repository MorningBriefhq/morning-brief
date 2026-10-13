// /api/tickers — the user's saved ticker list (session required).
//   GET    -> 200 {tickers:[...]} (sorted ascending)
//   POST   {ticker} -> validate (uppercase; 1-6 chars, A-Z plus . and -);
//                      max 10 tickers (403 {error:"ticker_limit"} beyond);
//                      duplicate add is idempotent -> 200 {ok:true, tickers}
//   DELETE ?ticker=NVDA -> 200 {ok:true, tickers:[...]}
// All unauthenticated requests -> 401 {error:"unauthorized"}.
// Any ticker symbol is accepted; the news pipeline skips symbols with no
// coverage, so unknown tickers simply yield no news.

import { json, badRequest, requireSession, readJson, nowSec } from "./_lib.js";

const FREE_TICKER_LIMIT = 10;

// Accepts ordinary equity/ETF symbols: 1-6 chars, letters, dots, dashes
// (covers BRK.B, BF-B, etc.).
const TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/;

async function listTickers(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT ticker FROM user_tickers WHERE user_id = ? ORDER BY ticker ASC"
  )
    .bind(userId)
    .all();
  return results.map((r) => r.ticker);
}

export async function onRequestGet(context) {
  const { user, response } = await requireSession(context.request, context.env);
  if (!user) return response;
  return json({ tickers: await listTickers(context.env, user.id) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const { user, response } = await requireSession(request, env);
  if (!user) return response;

  const body = await readJson(request);
  const ticker = String((body && body.ticker) || "").trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) return badRequest("invalid_ticker");

  // Verify the symbol actually exists via Finnhub; reject nonsense.
  if (env.FINNHUB_API_KEY) {
    try {
      const vres = await fetch(
        "https://finnhub.io/api/v1/search?q=" +
          encodeURIComponent(ticker) +
          "&token=" +
          encodeURIComponent(env.FINNHUB_API_KEY)
      );
      if (vres.ok) {
        const vdata = await vres.json();
        const vresults = Array.isArray(vdata.result) ? vdata.result : [];
        const known = vresults.some(
          (r) => String(r.symbol || "").toUpperCase() === ticker
        );
        if (!known) return badRequest("unknown_ticker");
      }
    } catch {
      // If Finnhub is unreachable, fall through to format-only validation
    }
  }

  const existing = await env.DB.prepare(
    "SELECT 1 FROM user_tickers WHERE user_id = ? AND ticker = ?"
  )
    .bind(user.id, ticker)
    .first();

  if (!existing) {
    const { n } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_tickers WHERE user_id = ?"
    )
      .bind(user.id)
      .first();
    if (user.plan === "free" && n >= FREE_TICKER_LIMIT) {
      return json({ error: "ticker_limit" }, 403);
    }
    await env.DB.prepare(
      "INSERT INTO user_tickers (user_id, ticker, added_at) VALUES (?, ?, ?)"
    )
      .bind(user.id, ticker, nowSec())
      .run();
  }

  return json({ ok: true, tickers: await listTickers(env, user.id) });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const { user, response } = await requireSession(request, env);
  if (!user) return response;

  const ticker = String(new URL(request.url).searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  if (ticker) {
    await env.DB.prepare("DELETE FROM user_tickers WHERE user_id = ? AND ticker = ?")
      .bind(user.id, ticker)
      .run();
  }

  return json({ ok: true, tickers: await listTickers(env, user.id) });
}
