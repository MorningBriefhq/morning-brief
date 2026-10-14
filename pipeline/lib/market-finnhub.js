// Morning Brief pipeline — Finnhub-backed market overview provider.
//
// Replaces the mock provider with real data:
//   topNews(runDate)   -> top 5-6 general market stories from Finnhub market news
//   beforeBell(runDate)-> pre-market snapshot (index ETF quotes via Finnhub)
//   calendar(runDate)  -> earnings (/calendar/earnings) + econ (/calendar/econ)
//   mergers(runDate)   -> M&A headlines from the merger news category
//   analysts(runDate)  -> upgrades/downgrades filtered from market news
//
// Falls back gracefully: any failed fetch returns an empty list for that
// section, and the email template hides empty sections.

const MA_KEYWORDS = /\bmerger\b|\bacquisition\b|\btakeover\b|\bbuyout\b|\bacquires\b|\bto acquire\b|\bmerging with\b/i;

const ANALYST_KEYWORDS = /\bupgrad\w*\b|\bdowngrad\w*\b|\bprice target\b|\braises target\b|\bcuts target\b|\boverweight\b|\bunderweight\b|\binitiated\b/i;

// Firms whose rating actions count as real analyst moves (not punditry)
const ANALYST_FIRMS = /\b(goldman|morgan stanley|jpmorgan|j\.p\. morgan|bernstein|barclays|citi|wells fargo|bank of america|bofa|deutsche bank|ubs|credit suisse|evercore|piper sandler|raymond james|stifel|keybanc|baird|rbc|td cowen|mizuho|nomura|hsbc|socgen|opportun|oppenheimer|jefferies|needham|rosenblatt|cantor|loop capital|guggenheim|wolfe|atlantic|da davidson|william blair|morningstar|argus|cfra|zacks)\b/i;

// Clickbait patterns to exclude from top news / picture selection
const CLICKBAIT = /\b(calculator|plug in your own|investing club|homestretch|what the updates mean for our stakes|top 10 things to watch)\b/i;

// Opinion/commentary markers that disqualify a headline
const PUNDIT_MARKERS = /\b(cramer|illustrates the|folly of|what it means|lessons from|why .* matters|here's why|opinion|commentary|breakingviews)\b/i;

// Stopwords for turning a headline into an Unsplash search query
const QUERY_STOP = new Set(
  "the a an and or of to in on for with as at by from is are was were be been it its this that says say said after amid over under new more most up down rise rises falls while could would will just now today week says us u.s. company companies ceo inc corp co group holdings global giant deal news report reports market markets stock stocks share shares billion million trillion price target rating".split(" ")
);

/** Build a short Unsplash query from the lead story's most distinctive words. */
function _photoQuery(story) {
  const text = `${story.headline || ""} ${story.summary || ""}`.toLowerCase();
  const seen = new Set();
  const words = [];
  for (const raw of text.split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || /^\d+$/.test(raw)) continue;
    if (QUERY_STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    words.push(raw);
    if (words.length >= 5) break;
  }
  return words.join(" ");
}

export class FinnhubMarketProvider {
  constructor(apiKey, fmpKey = null, sp500list = [], unsplashKey = null, fredKey = null) {
    this.key = apiKey;
    this.fmpKey = fmpKey;
    this.base = "https://finnhub.io/api/v1";
    this.sp500 = new Map(sp500list.map((s) => [s.ticker.toUpperCase(), s.name]));
    this.unsplashKey = unsplashKey;
    this.fredKey = fredKey;
  }

  async _get(path) {
    const res = await fetch(`${this.base}${path}${path.includes("?") ? "&" : "?"}token=${this.key}`);
    if (!res.ok) throw new Error(`finnhub ${path}: ${res.status}`);
    return res.json();
  }

  /** Top 5-6 market stories. */
  async topNews(_runDate) {
    try {
      const articles = await this._get("/news?category=general");
      // Filter clickbait and punditry
      const filtered = articles.filter((a) => {
        const h = a.headline || "";
        return h && !CLICKBAIT.test(h) && !PUNDIT_MARKERS.test(h);
      });

      // Deduplicate: cluster stories about the same event.
      // Two headlines are duplicates if they share 3+ significant words.
      const seen = new Set();
      const deduped = [];
      for (const a of filtered) {
        const words = new Set(
          (a.headline || "").toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 4 && !QUERY_STOP.has(w))
        );
        let isDup = false;
        for (const sig of seen) {
          const sigWords = sig.split("|");
          const overlap = sigWords.filter((w) => words.has(w)).length;
          if (overlap >= 3 && overlap >= Math.min(words.size, sigWords.length) * 0.4) {
            isDup = true;
            break;
          }
        }
        if (!isDup) {
          seen.add([...words].join("|"));
          deduped.push(a);
        }
        if (deduped.length >= 20) break; // enough for ranking
      }

      // Rank by significance: market-moving signals first.
      // Score: source quality + market keywords + recency
      const scored = deduped.map((a) => {
        let score = 0;
        const h = (a.headline || "").toLowerCase();
        const src = (a.source || "").toLowerCase();
        // Tier 1 sources
        if (/bloomberg|reuters|wall street journal|financial times|cnbc/i.test(src)) score += 3;
        else if (/marketwatch|barron|fortune|forbes/i.test(src)) score += 2;
        else if (src) score += 1;
        // Market-moving keywords
        if (/\b(fed|federal reserve|powell|rate cut|rate hike|inflation|cpi|payrolls|gdp)\b/.test(h)) score += 3;
        if (/\b(earnings|revenue|guidance|beats|misses)\b/.test(h)) score += 2;
        if (/\b(merger|acquisition|takeover|buyout)\b/.test(h)) score += 2;
        if (/\b(s&p|nasdaq|dow|futures|treasury|yield)\b/.test(h)) score += 2;
        if (/\b(china|tariff|trade war|opec|oil)\b/.test(h)) score += 1;
        // Longer summaries = more substance
        if ((a.summary || "").length > 150) score += 1;
        return { article: a, score };
      });
      scored.sort((x, y) => y.score - x.score);

      return scored.slice(0, 5).map(({ article: a }) => ({
        headline: a.headline || "",
        summary: (a.summary || "").slice(0, 280),
        url: a.url || "",
        source: a.source || "",
        image: a.image || "",
      }));
    } catch (e) {
      console.error("[market] topNews:", e.message);
      return [];
    }
  }

  /** Picture of the day: Unsplash editorial photo of the lead story,
      falling back to the lead story's own photo. */
  async pictureOfTheDay(topNews, summarizer = null) {
    const stories = (topNews || []).filter((s) => !CLICKBAIT.test(s.headline || ""));
    let photo = null;
    if (this.unsplashKey && stories.length) {
      try {
        photo = await this._unsplashPhoto(stories[0]);
      } catch (e) {
        console.error("[market] unsplash:", e.message);
      }
    }
    // No fallback to news thumbnails — Pat doesn't want CNBC/media images.
    // Unsplash or nothing.
    if (!photo) return null;

    // Informative caption: describe what the image shows and why it matters,
    // not just a repeat of the headline. A good picture IS information.
    if (summarizer && typeof summarizer.summarizeStory === "function" && photo.headline) {
      try {
        const caption = await summarizer.summarizeStory(
          "Picture caption",
          `In ONE sentence (max 25 words), write an informative caption for a photo accompanying this news story. ` +
          `Describe what the image likely shows and connect it to why this story matters to investors. ` +
          `Do not repeat the headline verbatim.\n\nStory: ${photo.headline}\n${photo.caption || ""}`
        );
        if (caption && caption.length > 10 && caption.length < 200) {
          photo.caption = caption;
        }
      } catch (e) {
        console.error("[market] picture caption:", e.message);
      }
    }
    return photo;
  }

  /** One landscape editorial photo from Unsplash matching the lead story. */
  async _unsplashPhoto(story) {
    const query = _photoQuery(story);
    if (!query) return null;
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&content_filter=high`,
      { headers: { Authorization: `Client-ID ${this.unsplashKey}` } }
    );
    if (!res.ok) throw new Error(`unsplash ${res.status}`);
    const data = await res.json();
    const hit = (data.results || [])[0];
    if (!hit || !hit.urls || !hit.urls.regular) return null;
    const photographer = (hit.user && hit.user.name) || "Unsplash";
    return {
      image: hit.urls.regular,
      caption: story.summary || story.headline,
      credit: `Photo by ${photographer} / Unsplash`,
      headline: story.headline,
    };
  }

  /** Pre-market snapshot: real index values first, ETF proxies as fallback.
   *
   *  Tries Finnhub index symbols (^GSPC, ^IXIC, ^DJI, ^VIX) — if the key
   *  supports them we get real index values per Pat's no-ETF-proxies rule.
   *  Then Alpha Vantage GLOBAL_QUOTE (free tier returns {} for indices, so
   *  this fails fast; kept as a slot that works if AV ever supports them).
   *  Falls back to SPY/QQQ/DIA when index quotes return no data.
   *  Macro series (Treasury, oil, gold, dollar) stay as-is.
   */
  async beforeBell(_runDate) {
    // Lazy import to avoid a hard dependency at module load.
    let fetchIndexQuoteAV = null;
    if (this.avKey) {
      try {
        ({ fetchIndexQuoteAV } = await import("./alphavantage.js"));
      } catch (e) {
        console.error("[market] beforeBell: could not load alphavantage module:", e.message);
      }
    }
    try {
      // [finnhubIndexSym, avIndexSym, etfFallback, label]
      const symbols = [
        ["^GSPC", "SPX", "SPY", "S&P 500"],
        ["^IXIC", "NDX", "QQQ", "Nasdaq 100"],
        ["^DJI", "DJI", "DIA", "Dow"],
        ["^VIX", null, null, "VIX"],
        [null, null, "TLT", "20-Yr Treasury"],
        [null, null, "USO", "WTI Crude"],
        [null, null, "GLD", "Gold"],
        [null, null, "UUP", "US Dollar"],
        [null, null, "EFA", "Europe"],
        [null, null, "EWJ", "Japan"],
      ];
      const quotes = [];
      const usedSymbols = [];
      for (const [indexSym, avSym, etfSym, label] of symbols) {
        let q = null;
        let used = null;
        // 1. Finnhub real index symbol
        if (indexSym) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              q = await this._get(`/quote?symbol=${encodeURIComponent(indexSym)}`);
              if (q && q.c != null && q.c !== 0) {
                used = indexSym;
                break;
              }
              q = null;
            } catch (e) {
              if (attempt === 2) console.error(`[market] beforeBell ${indexSym} failed:`, e.message);
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
          // Small delay to avoid rate limits
          await new Promise((r) => setTimeout(r, 500));
        }
        // 2. Alpha Vantage index quote (free tier: fails fast with {}, cached)
        if (!q && avSym && fetchIndexQuoteAV && this.avKey) {
          try {
            const avq = await fetchIndexQuoteAV(this.avKey, avSym);
            if (avq && avq.price) {
              q = { c: avq.price, dp: avq.changePct };
              used = `AV:${avSym}`;
              console.log(`[market] beforeBell ${label}: using Alpha Vantage index quote ${avSym}`);
            }
          } catch (e) {
            console.error(`[market] beforeBell AV ${avSym}:`, e.message);
          }
        }
        // 3. ETF fallback
        if (!q && etfSym) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              q = await this._get(`/quote?symbol=${encodeURIComponent(etfSym)}`);
              if (q && q.c != null && q.c !== 0) {
                used = etfSym;
                break;
              }
              q = null;
            } catch (e) {
              if (attempt === 2) console.error(`[market] beforeBell ${etfSym} failed:`, e.message);
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (used && used !== etfSym && (indexSym || avSym)) {
          console.log(`[market] beforeBell ${label}: using real index symbol ${used}`);
        }
        quotes.push(q);
        usedSymbols.push(used);
      }
      const fmt = (q, label) => {
        if (!q || q.c == null) return null;
        const chg = q.dp != null ? `${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}%` : "";
        return { label, text: `${chg} pre-market` };
      };
      return symbols
        .map(([, , , label], i) => fmt(quotes[i], label))
        .filter(Boolean);
    } catch (e) {
      console.error("[market] beforeBell:", e.message);
      return [];
    }
  }

  /** Key economic indicators from FRED (unemployment, CPI, Fed funds, 10Y). */
  async fredIndicators() {
    if (!this.fredKey) return null;
    try {
      const { fredKeyIndicators } = await import("./fred.js");
      return await fredKeyIndicators(this.fredKey);
    } catch (e) {
      console.error("[market] fred:", e.message);
      return null;
    }
  }

  /** Earnings + economic calendar for the run date. Only notable companies. */
  async calendar(runDate) {
    const out = { earnings: [], econ: [] };
    try {
      const data = await this._get(`/calendar/earnings?from=${runDate}&to=${runDate}`);
      const list = data.earningsCalendar || [];
      const hourLabel = (h) =>
        h === "bmo" ? "Before open" : h === "amc" ? "After close" : h === "dmh" ? "During market hours" : "";
      for (const e of list) {
        const symbol = (e.symbol || "").toUpperCase();
        const company = this.sp500.get(symbol);
        // Only names people recognize: S&P 500 members
        if (!company) continue;
        out.earnings.push({
          ticker: symbol,
          company,
          time: hourLabel(e.hour) || "Time TBA",
        });
        if (out.earnings.length >= 10) break;
      }
    } catch (e) {
      console.error("[market] earnings:", e.message);
    }
    try {
      const data = await this._get(`/calendar/econ?from=${runDate}&to=${runDate}`);
      const list = data.economicCalendar || [];
      out.econ = list.slice(0, 6).map((e) => ({
        time_et: e.time || "",
        event: e.event || "",
      }));
    } catch (e) {
      console.error("[market] econ:", e.message);
    }
    return out;
  }

  /** M&A headlines from the merger news category. Empty on quiet days. */
  async mergers(_runDate) {
    try {
      const articles = await this._get("/news?category=merger");
      const hits = articles.filter((a) =>
        MA_KEYWORDS.test(`${a.headline || ""} ${a.summary || ""}`)
      );
      return hits.slice(0, 4).map((a) => ({
        headline: a.headline || "",
        summary: (a.summary || "").slice(0, 280),
        url: a.url || "",
        source: a.source || "",
      }));
    } catch (e) {
      console.error("[market] mergers:", e.message);
      return [];
    }
  }

  /** Treasury yields from FMP (10Y and 2Y), for the Markets page. */
  async treasuryYields() {
    if (!this.fmpKey) return null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      const res = await fetch(
        `https://financialmodelingprep.com/stable/treasury-rates?from=${weekAgo}&to=${today}&apikey=${this.fmpKey}`
      );
      if (!res.ok) return null;
      const rates = await res.json();
      if (!Array.isArray(rates) || rates.length < 2) return null;
      const latest = rates[rates.length - 1];
      const prev = rates[rates.length - 2];
      return {
        as_of: latest.date,
        yields: [
          { key: "TNX", label: "10-Year", yield: latest.year10, prev_yield: prev.year10 },
          { key: "FVX", label: "2-Year", yield: latest.year2, prev_yield: prev.year2 },
        ].filter((y) => y.yield != null),
      };
    } catch (e) {
      console.error("[market] treasuryYields:", e.message);
      return null;
    }
  }

  /** Analyst upgrades/downgrades: FMP per-ticker grades + news filtering, deduped. */
  async analysts(_runDate, tickers = []) {
    const hits = [];
    const seen = new Set();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    // 1. FMP structured grades for user tickers + mega-caps (real upgrades/downgrades only)
    if (this.fmpKey) {
      const watchlist = [...new Set([...tickers, "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"])].slice(0, 10);
      for (const symbol of watchlist) {
        try {
          const res = await fetch(
            `https://financialmodelingprep.com/stable/grades?symbol=${symbol}&apikey=${this.fmpKey}&limit=10`
          );
          if (!res.ok) continue;
          const grades = await res.json();
          for (const g of grades) {
            const action = (g.action || "").toLowerCase();
            if (!["upgrade", "downgrade", "initiate", "initiated"].includes(action)) continue;
            const gDate = new Date(g.date || 0);
            if (gDate < cutoff) continue;
            const key = `${g.symbol}-${g.gradingCompany}-${g.date}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const prev = g.previousGrade || "";
            const curr = g.newGrade || "";
            hits.push({
              headline: `${g.symbol}: ${g.gradingCompany} ${action}s${prev && curr ? ` ${prev} → ${curr}` : ""}`.trim(),
              summary: g.gradingCompany ? `Analyst action from ${g.gradingCompany} on ${g.date}.` : "",
              url: "",
              source: g.gradingCompany || "FMP",
            });
            if (hits.length >= 8) break;
          }
        } catch (e) {
          console.error(`[market] analysts FMP ${symbol}:`, e.message);
        }
        if (hits.length >= 8) break;
      }
    }

    // 2. News filtering (always on, fills gaps)
    try {
      const [general, merger] = await Promise.all([
        this._get("/news?category=general"),
        this._get("/news?category=merger"),
      ]);
      for (const a of [...general, ...merger]) {
        const headline = a.headline || "";
        if (!ANALYST_KEYWORDS.test(headline)) continue;
        // Must name a real firm AND not be punditry
        if (!ANALYST_FIRMS.test(headline)) continue;
        if (PUNDIT_MARKERS.test(headline)) continue;
        const key = headline.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          headline,
          summary: (a.summary || "").slice(0, 280),
          url: a.url || "",
          source: a.source || "",
        });
        if (hits.length >= 8) break;
      }
    } catch (e) {
      console.error("[market] analysts news:", e.message);
    }

    return hits.slice(0, 8);
  }
}
