// Economic calendar — free sources, no keys required.
//
// Primary: FXMacroData (https://api.fxmacrodata.com/v1/calendar/USD)
//   Free, no key, no signup. Official release calendars: FOMC, CPI, NFP,
//   PPI, GDP, jobless claims, etc. Verified working 2026-10-14.
// Fallback: Nasdaq unofficial API (fragile, kept as last resort).

/** Tier-1 events worth naming in the brief. */
const TOP_TIER = new Set([
  "fomc", "federal_funds", "cpi", "core_cpi", "nonfarm_payrolls", "nfp",
  "unemployment", "gdp", "pce", "core_pce", "ppi", "retail_sales",
  "ism_manufacturing", "ism_services", "payrolls",
]);

/**
 * Get upcoming US economic releases.
 * @param {number} daysOut - how far ahead to look (default 7)
 * @returns {Promise<Array>} [{time_et, event, importance}] sorted by date
 */
export async function fetchEconCalendar(daysOut = 7) {
  // Primary: FXMacroData
  try {
    const res = await fetch("https://api.fxmacrodata.com/v1/calendar/USD");
    if (!res.ok) throw new Error(`fxmacrodata ${res.status}`);
    const data = await res.json();
    const items = data.data || [];

    const now = Date.now();
    const cutoff = now + daysOut * 864e5;

    const upcoming = [];
    for (const e of items) {
      const ts = e.announcement_datetime
        ? e.announcement_datetime * 1000
        : Date.parse(e.announcement_datetime_utc || 0);
      if (!ts || ts < now - 864e5 || ts > cutoff) continue; // today onward
      upcoming.push({
        ts,
        time_et: _formatET(ts),
        event: e.name || e.release || "",
        importance: e.event_importance || "low",
        tier: e.market_tier || 3,
        release_key: e.release || "",
      });
    }

    // Sort by date, then by importance (high first within a day)
    const impRank = { high: 0, medium: 1, low: 2 };
    upcoming.sort(
      (a, b) => a.ts - b.ts || (impRank[a.importance] ?? 2) - (impRank[b.importance] ?? 2)
    );

    // Dedupe same event on same day (weekly series repeat)
    const seen = new Set();
    const deduped = upcoming.filter((e) => {
      const key = `${e.event}|${new Date(e.ts).toISOString().slice(0, 10)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (deduped.length > 0) {
      console.log(`[econ] FXMacroData: ${deduped.length} upcoming USD releases (next ${daysOut}d)`);
      return deduped.slice(0, 12).map(({ ts, ...rest }) => rest);
    }
  } catch (e) {
    console.error("[econ] fxmacrodata:", e.message);
  }

  // Fallback: Nasdaq unofficial API
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `https://api.nasdaq.com/api/calendar/economicevents?date=${dateStr}`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (res.ok) {
      const data = await res.json();
      const rows = data?.data?.rows || [];
      if (rows.length > 0) {
        console.log(`[econ] Nasdaq fallback: ${rows.length} events`);
        return rows.slice(0, 12).map((r) => ({
          time_et: r.time || r.est_time || "",
          event: r.event || r.name || "",
          importance: "low",
        }));
      }
    }
  } catch (e) {
    console.error("[econ] nasdaq fallback:", e.message);
  }

  return [];
}

function _formatET(ts) {
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString("en-US", {
      timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
    });
    return `${date}, ${time} ET`;
  } catch {
    return "";
  }
}

/** Is this a top-tier market-moving release? */
export function isTopTierEcon(releaseKey) {
  const k = (releaseKey || "").toLowerCase();
  for (const t of TOP_TIER) {
    if (k.includes(t)) return true;
  }
  return false;
}

/**
 * Get treasury yields from FMP (already have key).
 */
export async function fetchTreasuryYields(fmpKey) {
  if (!fmpKey) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const res = await fetch(
      `https://financialmodelingprep.com/stable/treasury-rates?from=${weekAgo}&to=${today}&apikey=${fmpKey}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0] || null; // Most recent
  } catch (e) {
    console.error(`[treasury] ${e.message}`);
    return null;
  }
}
