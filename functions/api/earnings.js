import { json } from "./_lib.js";
import sp100 from "../../data/sp100.json";
import irUrls from "../../data/ir_urls.json";

// Upcoming week's S&P 100 earnings calendar.
// Fetched live from Finnhub. Each ticker links to the company's IR page
// (where earnings calls live), falling back to Yahoo Finance. Cached 1 hour.
const sp100Map = new Map(sp100.map((s) => [s.ticker.toUpperCase(), s.name]));

export async function onRequestGet(context) {
  const { env } = context;
  const key = env.FINNHUB_API_KEY;
  if (!key) return json({ error: "unavailable" }, 503);

  const today = new Date();
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 7 * 864e5).toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`
    );
    if (!res.ok) return json({ error: "unavailable" }, 503);
    const data = await res.json();
    const list = data.earningsCalendar || [];

    const hourLabel = (h) =>
      h === "bmo" ? "Before open" : h === "amc" ? "After close" : h === "dmh" ? "During hours" : "TBA";

    // Filter to S&P 100 first, then fetch quarterly perf in parallel
    const filtered = list.filter((e) => sp100Map.has((e.symbol || "").toUpperCase()));

    async function getQtrPerf(symbol) {
      try {
        const yres = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
          { headers: { "User-Agent": "Mozilla/5.0" } }
        );
        if (!yres.ok) return null;
        const ydata = await yres.json();
        const result = ydata?.chart?.result?.[0];
        const closes = result?.indicators?.quote?.[0]?.close?.filter((c) => c != null);
        if (closes && closes.length > 1 && closes[0] > 0) {
          return Math.round(((closes[closes.length - 1] - closes[0]) / closes[0]) * 10000) / 100;
        }
      } catch (err) { /* unavailable */ }
      return null;
    }

    const qtrPerfs = await Promise.all(
      filtered.map((e) => getQtrPerf((e.symbol || "").toUpperCase()))
    );

    const earnings = filtered.map((e, i) => {
      const symbol = (e.symbol || "").toUpperCase();
      const company = sp100Map.get(symbol);
      return {
        ticker: symbol,
        company,
        date: e.date,
        time: hourLabel(e.hour),
        eps_estimate: e.epsEstimate ?? null,
        revenue_estimate: e.revenueEstimate ?? null,
        qtr_perf: qtrPerfs[i],
        // Direct to IR page where the earnings call lives; Yahoo as fallback
        link: irUrls[symbol] || `https://finance.yahoo.com/quote/${symbol}`,
        is_ir: !!irUrls[symbol],
      };
    });

    // Sort by date, then by time (before open first)
    const timeOrder = { "Before open": 0, "During hours": 1, "After close": 2, TBA: 3 };
    earnings.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (timeOrder[a.time] ?? 3) - (timeOrder[b.time] ?? 3);
    });

    return json(
      { from, to, count: earnings.length, earnings },
      200,
      { "Cache-Control": "public, max-age=21600" } // 6 hours — quarterly perf doesn't change intraday
    );
  } catch (e) {
    return json({ error: "unavailable" }, 503);
  }
}
