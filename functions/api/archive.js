// /api/archive — public newsletter archive (market sections only, no personalization).
//   GET /api/archive -> { dates: ["2026-10-12", ...] } (newest first)
//   GET /api/archive?date=2026-10-12 -> { date, sections: { top_news, before_bell, mergers, analysts, calendar } }
import { json } from "./_lib.js";

const SECTIONS = ["top_news", "before_bell", "mergers", "analysts", "calendar", "picture"];

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const date = url.searchParams.get("date");

  // D1 binding absent (e.g. preview deployments) — degrade gracefully
  // instead of throwing (Cloudflare 1101). Production always has DB.
  if (!env.DB) {
    if (!date) return json({ dates: [] }, 503);
    const sections = {};
    for (const s of SECTIONS) {
      sections[s] = s === "calendar" ? { earnings: [], econ: [] } : s === "picture" ? null : [];
    }
    return json({ date, sections }, 503);
  }

  if (!date) {
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT run_date AS d FROM market_briefs ORDER BY d DESC LIMIT 90"
    ).all();
    return json({ dates: results.map((r) => r.d) }, 200, { "Cache-Control": "public, max-age=3600" });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "bad_date" }, 400);
  }

  const { results } = await env.DB.prepare(
    "SELECT section, payload FROM market_briefs WHERE run_date = ?"
  ).bind(date).all();

  const sections = {};
  for (const s of SECTIONS) {
    sections[s] = s === "calendar" ? { earnings: [], econ: [] } : s === "picture" ? null : [];
  }
  for (const row of results) {
    try {
      sections[row.section] = JSON.parse(row.payload);
    } catch {}
  }

  return json({ date, sections }, 200, { "Cache-Control": "public, max-age=86400" });
}
