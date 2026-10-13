import { json } from "./_lib.js";

// Live market data — all from Yahoo Finance (real indices/futures, no ETF proxies).
// Cached 5 minutes at edge.
const SYMBOLS = [
  ["%5EGSPC", "S&P 500", "indices"],
  ["%5ENDX", "Nasdaq 100", "indices"],
  ["%5EDJI", "Dow", "indices"],
  ["%5EVIX", "VIX", "indices"],
  ["CL%3DF", "WTI Crude", "commodities"],
  ["GC%3DF", "Gold", "commodities"],
  ["DX-Y.NYB", "US Dollar", "currencies"],
  ["%5EGDAXI", "DAX", "global"],
  ["%5EFTSE", "FTSE 100", "global"],
  ["%5EN225", "Nikkei 225", "global"],
];

async function yahooChart(sym) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1mo`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const closes = result.indicators?.quote?.[0]?.close?.filter((c) => c != null);
  if (!closes || closes.length < 2) return null;
  return closes;
}

export async function onRequestGet(context) {
  // Fetch all symbols in parallel — one 1mo request each covers price + sparkline
  const results = await Promise.all(
    SYMBOLS.map(async ([sym, label, category]) => {
      try {
        const closes = await yahooChart(sym);
        if (!closes) return null;
        const cur = closes[closes.length - 1];
        const prev = closes[closes.length - 2];
        const chgPct = Math.round(((cur - prev) / prev) * 10000) / 100;
        return {
          key: sym,
          label,
          category,
          price: Math.round(cur * 100) / 100,
          abs_change: Math.round((cur - prev) * 100) / 100,
          change_pct: chgPct,
          up: chgPct >= 0,
          is_yield: false,
          spark: closes.slice(-30),
        };
      } catch (e) {
        return null;
      }
    })
  );

  const items = [];
  const sparkData = {};
  for (const r of results) {
    if (!r) continue;
    sparkData[r.key] = r.spark;
    delete r.spark;
    items.push(r);
  }

  // Treasury yields from D1 (fetched by the 4 AM pipeline run via FMP)
  try {
    const { env } = context;
    const row = await env.DB.prepare(
      `SELECT payload FROM market_briefs
       WHERE section = 'treasury_yields' ORDER BY run_date DESC LIMIT 1`
    ).first();
    if (row) {
      const ty = JSON.parse(row.payload);
      if (ty && Array.isArray(ty.yields)) {
        for (const y of ty.yields) {
          if (y.yield == null) continue;
          const bpChg = y.prev_yield != null ? Math.round((y.yield - y.prev_yield) * 100) : 0;
          items.push({
            key: y.key,
            label: y.label,
            category: "rates",
            price: Math.round(y.yield * 100) / 100,
            abs_change: null,
            change_pct: null,
            up: bpChg >= 0,
            is_yield: true,
            bp_change: bpChg,
          });
        }
      }
    }
  } catch (e) { /* yields unavailable */ }

  // Sort: indices, rates, commodities, currencies, global
  items.sort((a, b) => {
    const order = { indices: 0, rates: 1, commodities: 2, currencies: 3, global: 4 };
    return (order[a.category] ?? 9) - (order[b.category] ?? 9);
  });

  if (!items.length) return json({ error: "unavailable" }, 503);

  return json(
    { as_of: new Date().toISOString(), live: true, items, sparklines: sparkData },
    200,
    { "Cache-Control": "public, max-age=300" }
  );
}
