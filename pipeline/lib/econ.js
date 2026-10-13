// Economic calendar and additional market data sources.
// Free, no-key sources to fill LSEG gaps.

/**
 * Fetch today's economic events from a free source.
 * Uses ForexFactory-style data via a public JSON endpoint.
 */
export async function fetchEconCalendar(dateStr) {
  // Try multiple free sources
  const sources = [
    // Nasdaq economic calendar (if available)
    `https://api.nasdaq.com/api/calendar/economicevents?date=${dateStr}`,
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const rows = data?.data?.rows || [];
      if (rows.length > 0) {
        return rows.map((r) => ({
          time: r.time || r.est_time || "",
          event: r.event || r.name || "",
          forecast: r.forecast || "",
          previous: r.previous || "",
        }));
      }
    } catch (e) {
      console.error(`[econ] ${url}: ${e.message}`);
    }
  }
  return [];
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
