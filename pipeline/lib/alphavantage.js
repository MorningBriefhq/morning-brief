// Alpha Vantage integration — free tier (25 requests/day).
//
// Endpoints:
//   EARNINGS_CALENDAR — free, CSV. Fallback when Finnhub earnings calendar is empty.
//                       Verified working 2026-10-14 (returned BAC, BLK, MS, PGR, etc.)
//   GLOBAL_QUOTE      — free, but index symbols (SPX) return {} on free tier.
//                       Wired as a last-resort fallback; fails fast and silently.
//   NEWS_SENTIMENT    — PREMIUM ONLY on the free key. Attempted once per run;
//                       on the "premium endpoint" response we disable it with a
//                       clear log and skip. If Pat upgrades to paid, it starts
//                       working automatically — no code change needed.
//
// Rate budget: the market stage runs once per run_date (idempotent), so worst
// case is ~6 AV calls/day — well under the 25/day free cap. A module-level
// cache guards against accidental re-runs within 12h.

const AV_BASE = "https://www.alphavantage.co/query";

// ---------------------------------------------------------------------------
// Cache + error detection
// ---------------------------------------------------------------------------

const _cache = new Map();
const CACHE_TTL_MS = 12 * 3600 * 1000;

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return hit.data;
}

function _cacheSet(key, data) {
  _cache.set(key, { ts: Date.now(), data });
}

/** Returns an error string for AV Information/Note/Error responses, else null. */
function _avError(data) {
  if (!data || typeof data !== "object") return null;
  if (data.Information) return data.Information.slice(0, 140);
  if (data.Note) return `rate limit: ${data.Note.slice(0, 120)}`;
  if (data["Error Message"]) return data["Error Message"].slice(0, 140);
  return null;
}

function _isPremiumGated(info) {
  return /premium endpoint/i.test(info || "");
}

// Module-level flag: once NEWS_SENTIMENT reports premium-only, stop trying.
let _sentimentPremium = false;

// ---------------------------------------------------------------------------
// Minimal CSV parser (handles quoted fields with commas)
// ---------------------------------------------------------------------------

function _parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function _titleCase(s) {
  return (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function _timeLabel(t) {
  const v = (t || "").toLowerCase();
  if (v.includes("pre")) return "Before open";
  if (v.includes("post") || v.includes("after")) return "After close";
  if (v.includes("during")) return "During market hours";
  return "Time TBA";
}

// ---------------------------------------------------------------------------
// 1. Earnings calendar (free CSV)
// ---------------------------------------------------------------------------

/**
 * Fetch today's earnings from Alpha Vantage EARNINGS_CALENDAR.
 * @param {string} apiKey
 * @param {Map} sp500Map - ticker (upper) -> friendly company name
 * @param {string} runDate - YYYY-MM-DD to match reportDate
 * @returns {Promise<Array>} [{ticker, company, time, estimate}]
 */
export async function fetchEarningsCalendarAV(apiKey, sp500Map, runDate) {
  if (!apiKey) return [];
  const cacheKey = `av:earnings:${runDate}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = `${AV_BASE}?function=EARNINGS_CALENDAR&horizon=3month&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    const text = await res.text();
    // Error responses come back as JSON, not CSV
    if (text.trim().startsWith("{")) {
      const err = _avError(JSON.parse(text));
      throw new Error(err || "unexpected JSON response");
    }
    const rows = _parseCsv(text);
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => h.trim());
    const idx = {
      symbol: header.indexOf("symbol"),
      name: header.indexOf("name"),
      reportDate: header.indexOf("reportDate"),
      estimate: header.indexOf("estimate"),
      timeOfTheDay: header.indexOf("timeOfTheDay"),
    };
    if (idx.symbol < 0 || idx.reportDate < 0) {
      throw new Error("unexpected CSV columns");
    }
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if ((r[idx.reportDate] || "").trim() !== runDate) continue;
      const symbol = (r[idx.symbol] || "").trim().toUpperCase();
      if (!symbol) continue;
      // Only names people recognize: S&P 500 members
      const company = sp500Map ? sp500Map.get(symbol) : null;
      if (!company) continue;
      out.push({
        ticker: symbol,
        company,
        time: _timeLabel(r[idx.timeOfTheDay]),
        estimate: (r[idx.estimate] || "").trim() || null,
      });
      if (out.length >= 12) break;
    }
    console.log(`[alphavantage] earnings calendar: ${out.length} S&P 500 names for ${runDate}`);
    _cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    console.error(`[alphavantage] earnings calendar: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Index quotes (free tier returns {} for indices — last-resort fallback)
// ---------------------------------------------------------------------------

/**
 * Try an Alpha Vantage GLOBAL_QUOTE for an index symbol.
 * Free tier does NOT support index symbols (returns {}) — this fails fast.
 * @returns {Promise<{price:number, changePct:number}|null>}
 */
export async function fetchIndexQuoteAV(apiKey, symbol) {
  if (!apiKey) return null;
  const cacheKey = `av:quote:${symbol}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== null) return cached; // null is a valid cached "no data"

  try {
    const url = `${AV_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    const err = _avError(data);
    if (err) throw new Error(err);
    const q = data["Global Quote"] || {};
    const price = parseFloat(q["05. price"]);
    const changePct = parseFloat((q["10. change percent"] || "").replace("%", ""));
    if (!price) {
      // Empty {} — index not supported on this tier. Cache the miss.
      _cacheSet(cacheKey, null);
      return null;
    }
    const out = { price, changePct: isNaN(changePct) ? null : changePct };
    _cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    console.error(`[alphavantage] index quote ${symbol}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. News sentiment (PREMIUM ONLY on free key — attempted once, then disabled)
// ---------------------------------------------------------------------------

/**
 * Fetch market news with sentiment from Alpha Vantage NEWS_SENTIMENT.
 * On the free key this endpoint is premium-gated: we detect that once,
 * log it clearly, and skip on all subsequent calls (no wasted rate limit).
 * @returns {Promise<Array>} articles [{headline, summary, url, source, sentiment, datetime}]
 */
export async function fetchNewsSentimentAV(apiKey, { topics = "financial_markets,economy_macro,earnings", limit = 10 } = {}) {
  if (!apiKey) return [];
  if (_sentimentPremium) return []; // already know it's gated

  const cacheKey = `av:sentiment:${topics}:${limit}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url =
      `${AV_BASE}?function=NEWS_SENTIMENT` +
      `&topics=${encodeURIComponent(topics)}` +
      `&sort=LATEST&limit=${limit}&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    const err = _avError(data);
    if (err) {
      if (_isPremiumGated(err)) {
        _sentimentPremium = true;
        console.warn("[alphavantage] NEWS_SENTIMENT is premium-only on this key — skipping (will work automatically if upgraded to paid)");
        return [];
      }
      throw new Error(err);
    }
    const feed = data.feed || [];
    const out = feed
      .map((a) => ({
        datetime: a.time_published
          ? Date.parse(
              a.time_published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:00Z")
            ) / 1000
          : 0,
        headline: (a.title || "").trim(),
        source: (a.source || "").trim(),
        summary: (a.summary || "").trim(),
        url: a.url || "",
        image: a.banner_image || "",
        sentiment: typeof a.overall_sentiment_score === "number" ? a.overall_sentiment_score : null,
        sentimentLabel: a.overall_sentiment_label || null,
        fullText: "",
      }))
      .filter((a) => a.headline);
    console.log(`[alphavantage] news sentiment: ${out.length} articles`);
    _cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    console.error(`[alphavantage] news sentiment: ${e.message}`);
    return [];
  }
}
