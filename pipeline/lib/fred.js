// FRED economic data integration.
// Provides key economic indicators for Before the Bell context.

const FRED_BASE = "https://api.stlouisfed.org/fred";

/**
 * Get the latest value for a FRED series.
 * @param {string} apiKey - FRED API key
 * @param {string} seriesId - e.g., "UNRATE", "CPIAUCSL", "FEDFUNDS"
 * @returns {Promise<{value, date} | null>}
 */
export async function fredLatest(apiKey, seriesId) {
  if (!apiKey) return null;
  try {
    const url = `${FRED_BASE}/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const obs = data?.observations?.[0];
    if (!obs || obs.value === ".") return null;
    return { value: parseFloat(obs.value), date: obs.date };
  } catch (e) {
    console.error(`[fred] ${seriesId}: ${e.message}`);
    return null;
  }
}

/**
 * Get key economic indicators for the brief.
 * Returns: unemployment, CPI YoY, Fed funds rate, 10Y Treasury, GDP
 */
export async function fredKeyIndicators(apiKey) {
  if (!apiKey) return null;

  const series = {
    UNRATE: "Unemployment Rate",
    CPIAUCSL: "CPI",
    FEDFUNDS: "Fed Funds Rate",
    DGS10: "10Y Treasury",
    GDP: "GDP",
  };

  const results = {};
  for (const [id, label] of Object.entries(series)) {
    const data = await fredLatest(apiKey, id);
    if (data) results[id] = { ...data, label };
  }
  return results;
}
