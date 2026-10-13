// GET /api/universe -> 200 {as_of, count, stocks:[{ticker,name}]}
// Served from the bundled data/sp500.json (same-origin fetch, cached per
// isolate). Client-cacheable: Cache-Control: public, max-age=86400.

import { json } from "./_lib.js";

let payload = null;

export async function onRequestGet(context) {
  const { request } = context;

  if (!payload) {
    const res = await fetch(new URL("/data/sp500.json", request.url).toString());
    if (!res.ok) return json({ error: "universe_unavailable" }, 500);
    const data = await res.json();
    const stocks = (data.stocks || []).map((s) => ({
      ticker: String(s.ticker).toUpperCase(),
      name: String(s.name),
    }));
    payload = { as_of: data.as_of, count: stocks.length, stocks };
  }

  return json(payload, 200, { "Cache-Control": "public, max-age=86400" });
}
