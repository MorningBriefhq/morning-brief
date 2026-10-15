// Morning Brief pipeline — keyless market quotes (REAL indices & futures).
//
// Pat's rule: real indices/futures, NO ETF proxies. This module is the single
// source of market numbers for Before the Bell, the futures strip, and the
// overnight block.
//
// Primary source: Stooq CSV (https://stooq.com/q/l/?s=...&f=sd2t2ohlcv&h&e=csv),
// keyless. NOTE (verified 2026-10-15): Stooq now fronts requests with a JS
// proof-of-work bot gate — server-side fetches get HTTP 404 on /q/l/ itself.
// Stooq is attempted first as a fast-fail; the effective source is the Yahoo
// Finance chart API fallback (keyless, verified working 2026-10-15). If both
// fail we return null and the caller ships the section EMPTY (loud) — we
// NEVER fall back to SPY/QQQ/DIA or other ETF proxies.
//
// Quote contract per symbol: { price, change, changePct } (numbers; any may
// be null when the source doesn't provide it).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// key: internal id | stooq: Stooq CSV symbol | yahoo: Yahoo chart symbol
// label: display label | decimals: price decimals | kind: future|cash|vol|yield|fx|overnight
const SYMBOLS = [
  { key: "es",   stooq: "esz26", yahoo: "ES=F",      label: "S&P 500 futures",    decimals: 2, kind: "future" },
  { key: "nq",   stooq: "nqz26", yahoo: "NQ=F",      label: "Nasdaq 100 futures", decimals: 2, kind: "future" },
  { key: "ym",   stooq: "ymz26", yahoo: "YM=F",      label: "Dow futures",        decimals: 2, kind: "future" },
  { key: "spx",  stooq: "^spx",  yahoo: "^GSPC",     label: "S&P 500",            decimals: 2, kind: "cash" },
  { key: "ndx",  stooq: "^ndq",  yahoo: "^NDX",      label: "Nasdaq 100",         decimals: 2, kind: "cash" },
  { key: "dji",  stooq: "^dji",  yahoo: "^DJI",      label: "Dow",                decimals: 2, kind: "cash" },
  { key: "vix",  stooq: "^vix",  yahoo: "^VIX",      label: "VIX",                decimals: 2, kind: "vol" },
  { key: "tnx",  stooq: "^tnx",  yahoo: "^TNX",      label: "10-Year yield",      decimals: 2, kind: "yield" },
  { key: "wti",  stooq: "cl.f",  yahoo: "CL=F",      label: "WTI crude",          decimals: 2, kind: "future" },
  { key: "gold", stooq: "gc.f",  yahoo: "GC=F",      label: "Gold",               decimals: 2, kind: "future" },
  { key: "dxy",  stooq: "^dxy",  yahoo: "DX-Y.NYB",  label: "US Dollar index",    decimals: 2, kind: "fx" },
  // Overnight: Asia/Europe cash indices
  { key: "n225", stooq: "^n225", yahoo: "^N225",     label: "Nikkei 225",         decimals: 2, kind: "overnight" },
  { key: "hsi",  stooq: "^hsi",  yahoo: "^HSI",      label: "Hang Seng",          decimals: 2, kind: "overnight" },
  { key: "shc",  stooq: "^shc",  yahoo: "000001.SS", label: "Shanghai Composite", decimals: 2, kind: "overnight" },
  { key: "ukx",  stooq: "^ukx",  yahoo: "^FTSE",     label: "FTSE 100",           decimals: 2, kind: "overnight" },
  { key: "sx5e", stooq: "^sx5e", yahoo: "^STOXX50E", label: "Euro Stoxx 50",      decimals: 2, kind: "overnight" },
];

const BY_KEY = new Map(SYMBOLS.map((s) => [s.key, s]));

/** Stooq CSV attempt: /q/l/ snapshot + /q/d/l/ daily history for prev closes.
 *  Throws on any failure so the caller can fall through to Yahoo. */
async function fetchStooq() {
  const snapRes = await fetch(
    `https://stooq.com/q/l/?s=${encodeURIComponent(SYMBOLS.map((s) => s.stooq).join(","))}&f=sd2t2ohlcv&h&e=csv`,
    { headers: { "User-Agent": UA } }
  );
  if (!snapRes.ok) throw new Error(`stooq /q/l/ ${snapRes.status}`);
  const snapText = await snapRes.text();
  if (/<html/i.test(snapText.slice(0, 200))) throw new Error("stooq /q/l/ returned HTML (bot gate)");
  const closes = new Map();
  for (const line of snapText.trim().split("\n").slice(1)) {
    const [sym, , , , , , close] = line.split(",");
    const c = parseFloat(close);
    if (sym && Number.isFinite(c)) closes.set(sym.toLowerCase(), c);
  }
  if (closes.size === 0) throw new Error("stooq /q/l/ parsed 0 rows");
  // Prev closes from daily history (needed for change/changePct).
  const out = new Map();
  await Promise.all(
    SYMBOLS.map(async (s) => {
      try {
        const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s.stooq)}&i=d`, {
          headers: { "User-Agent": UA },
        });
        if (!r.ok) return;
        const t = await r.text();
        const rows = t.trim().split("\n").slice(1).filter((l) => l && !/N\/D/.test(l));
        if (rows.length < 2) return;
        const prevClose = parseFloat(rows[rows.length - 2].split(",")[4]);
        const price = closes.get(s.stooq.toLowerCase());
        if (!Number.isFinite(prevClose) || !Number.isFinite(price)) return;
        const change = price - prevClose;
        out.set(s.key, { price, change, changePct: prevClose ? (change / prevClose) * 100 : null });
      } catch {
        // per-symbol failure: skip, don't kill the batch
      }
    })
  );
  if (out.size === 0) throw new Error("stooq: no usable quotes");
  return out;
}

/** Yahoo Finance chart API attempt (keyless). One request per symbol;
 *  per-symbol failures are logged and skipped — partial data beats none. */
async function fetchYahoo() {
  const out = new Map();
  const settled = await Promise.allSettled(
    SYMBOLS.map(async (s) => {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.yahoo)}?interval=1d&range=2d`,
        { headers: { "User-Agent": UA } }
      );
      if (!res.ok) throw new Error(`yahoo ${s.yahoo}: ${res.status}`);
      const data = await res.json();
      const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
      if (!meta || meta.regularMarketPrice == null) throw new Error(`yahoo ${s.yahoo}: no price in meta`);
      return [
        s.key,
        {
          price: meta.regularMarketPrice,
          change: meta.fulldayChange ?? meta.regularMarketChange ?? null,
          changePct: meta.fulldayChangePercent ?? meta.regularMarketChangePercent ?? null,
        },
      ];
    })
  );
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") out.set(r.value[0], r.value[1]);
    else console.error(`[stooq] quote miss ${SYMBOLS[i].key} (${SYMBOLS[i].yahoo}):`, r.reason && r.reason.message);
  }
  if (out.size === 0) throw new Error("yahoo: no usable quotes");
  return out;
}

/** Fetch all configured quotes. Returns { quotes: Map, source } or
 *  { quotes: null, source: null } when every source failed (loud). */
export async function fetchMarketQuotes() {
  try {
    const quotes = await fetchStooq();
    console.log(`[stooq] source=stooq quotes=${quotes.size}/${SYMBOLS.length}`);
    return { quotes, source: "stooq" };
  } catch (e) {
    console.error("[stooq] stooq failed:", e.message, "— trying Yahoo");
  }
  try {
    const quotes = await fetchYahoo();
    console.log(`[stooq] source=yahoo quotes=${quotes.size}/${SYMBOLS.length}`);
    return { quotes, source: "yahoo" };
  } catch (e) {
    console.error("[stooq] ALL quote sources failed:", e.message, "— market sections will be EMPTY (no ETF proxies)");
    return { quotes: null, source: null };
  }
}

// ---- formatting ------------------------------------------------------------

export function fmtPrice(v, decimals = 2) {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtSignedPct(v, decimals = 2) {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}%`;
}

function fmtSigned(v, decimals = 2) {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

// ---- market-clock helpers (America/New_York) --------------------------------

function etParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get("weekday"), minutes: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10) };
}

/** "live" when the NYSE cash session is open right now, else "prior close". */
export function cashMarketNote() {
  const { weekday, minutes } = etParts();
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  return isWeekday && minutes >= 570 && minutes < 960 ? "live" : "prior close";
}

/** True when London is in its cash session (roughly 3:00–11:30 ET). */
function europeOpenNow() {
  const { weekday, minutes } = etParts();
  return !["Sat", "Sun"].includes(weekday) && minutes >= 180 && minutes < 690;
}

// ---- section builders ------------------------------------------------------
// Rows: { label, level, change, pct, note } — level/change are display
// strings, pct is the numeric day change % (for color + red-day logic).

/** Before the Bell: futures (real pre-market), cash indices (labeled honestly),
 *  VIX, 10Y as a level, WTI/gold futures, DXY. Missing symbols are skipped. */
export function buildBeforeBell(quotes) {
  if (!quotes) return [];
  const cashNote = cashMarketNote();
  const row = (key, note) => {
    const q = quotes.get(key);
    const spec = BY_KEY.get(key);
    if (!q || !Number.isFinite(q.price)) return null;
    const isYield = spec.kind === "yield";
    return {
      label: spec.label,
      level: isYield ? `${q.price.toFixed(2)}%` : fmtPrice(q.price, spec.decimals),
      change: isYield ? fmtSigned(q.change) : fmtSignedPct(q.changePct),
      pct: Number.isFinite(q.changePct) ? q.changePct : null,
      note: note || "",
    };
  };
  return [
    row("es", "pre-market"),
    row("nq", "pre-market"),
    row("ym", "pre-market"),
    row("spx", cashNote),
    row("ndx", cashNote),
    row("dji", cashNote),
    row("vix", ""),
    row("tnx", ""),
    row("wti", "futures"),
    row("gold", "futures"),
    row("dxy", ""),
  ].filter(Boolean);
}

/** Futures strip: S&P / Nasdaq / Dow futures as big numerals. */
export function buildFuturesStrip(quotes) {
  if (!quotes) return [];
  const names = { es: "S&P", nq: "NASDAQ", ym: "DOW" };
  return ["es", "nq", "ym"]
    .map((key) => {
      const q = quotes.get(key);
      if (!q || !Number.isFinite(q.price)) return null;
      return { name: names[key], level: fmtPrice(q.price, 2), pct: Number.isFinite(q.changePct) ? q.changePct : null };
    })
    .filter(Boolean);
}

/** Overnight block rows: { label, pct }. Compact line for the template and
 *  the day-take thesis prompt. */
export function buildOvernight(quotes) {
  if (!quotes) return [];
  return ["n225", "hsi", "shc", "ukx", "sx5e"]
    .map((key) => {
      const q = quotes.get(key);
      const spec = BY_KEY.get(key);
      if (!q || !Number.isFinite(q.changePct)) return null;
      return { label: spec.label, pct: q.changePct };
    })
    .filter(Boolean);
}

export function buildOvernightLine(rows) {
  if (!rows || rows.length === 0) return "";
  const parts = rows.map((r) => `${r.label} ${fmtSignedPct(r.pct)}`);
  let line = parts.join(" · ");
  if (europeOpenNow()) line += " — Europe mid-session";
  return line;
}
