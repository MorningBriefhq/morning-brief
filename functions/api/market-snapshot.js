import { json } from "./_lib.js";

// Public market snapshot for the homepage.
// Served from the latest 4am pipeline run in D1. Cached 5 minutes at edge.
const LABELS = { "S&P 500": "S&P 500", "Nasdaq 100": "Nasdaq", "Dow": "Dow" };

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const row = await env.DB.prepare(
      `SELECT run_date, payload FROM market_briefs
       WHERE section = 'before_bell' ORDER BY run_date DESC LIMIT 1`
    ).first();
    if (!row) return json({ error: "unavailable" }, 503);
    const items = JSON.parse(row.payload);
    // before_bell items are {label, text}; extract % change from text
    const out = items.map((it) => {
      const m = /([+-]?\d+\.\d+)%/.exec(it.text || "");
      const chg = m ? parseFloat(m[1]) : 0;
      return {
        key: it.label,
        label: LABELS[it.label] || it.label,
        change_pct: chg,
        up: chg >= 0,
      };
    });
    return json(
      { as_of: row.run_date, items: out },
      200,
      { "Cache-Control": "public, max-age=300" }
    );
  } catch (e) {
    return json({ error: "unavailable" }, 503);
  }
}
