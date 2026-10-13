// /api/ticker-name — company name for a ticker symbol (session required).
//   GET ?ticker=SPCX -> 200 {ticker:"SPCX", name:"Space Exploration Technologies Corp"}
// Used for tickers outside the S&P 500 universe, which has no name data.
// Looks up via Finnhub symbol search; returns the best match or null name.
// All unauthenticated requests -> 401 {error:"unauthorized"}.

import { json, badRequest, requireSession } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const { user, response } = await requireSession(request, env);
  if (!user) return response;

  const ticker = String(new URL(request.url).searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,5}$/.test(ticker)) return badRequest("invalid_ticker");

  let name = null;
  if (env.FINNHUB_API_KEY) {
    try {
      const res = await fetch(
        "https://finnhub.io/api/v1/search?q=" +
          encodeURIComponent(ticker) +
          "&token=" +
          encodeURIComponent(env.FINNHUB_API_KEY)
      );
      if (res.ok) {
        const data = await res.json();
        const results = Array.isArray(data.result) ? data.result : [];
        // Prefer an exact symbol match; fall back to the first result.
        const exact = results.find(
          (r) => String(r.symbol || "").toUpperCase() === ticker
        );
        const pick = exact || results[0];
        if (pick && pick.description) name = String(pick.description).trim() || null;
      }
    } catch {
      // fall through with name = null
    }
  }

  return json({ ticker, name }, 200, { "Cache-Control": "public, max-age=86400" });
}
