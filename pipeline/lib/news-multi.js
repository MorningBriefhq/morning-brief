// Multi-source institutional news provider.
// Combines curated RSS wires, Marketaux (US entities), Guardian (US business), and GDELT,
// pools corroborating coverage into story clusters, and enriches winners with full article text.

import { fetchArticleText } from "./article.js";
import { fetchAllFeeds } from "./rss.js";
import { fetchNewsSentimentAV } from "./alphavantage.js";
import sp500Raw from "../../data/sp500.json" with { type: "json" };

// Build fast lookup sets for all 500 S&P tickers and normalized company names
const SP500_LIST = Array.isArray(sp500Raw) ? sp500Raw : sp500Raw.stocks || sp500Raw.tickers || sp500Raw.companies || [];
const SP500_TICKERS = new Set();
const SP500_NAMES = [];

for (const item of SP500_LIST) {
  if (typeof item === "string") {
    SP500_TICKERS.add(item.toUpperCase());
  } else if (item && typeof item === "object") {
    const sym = (item.ticker || item.symbol || "").toUpperCase().trim();
    if (sym) SP500_TICKERS.add(sym);
    const name = (item.company || item.name || "")
      .toLowerCase()
      .replace(/\b(inc\.?|corp\.?|corporation|company|co\.?|plc|ltd\.?|group|holdings?)\b/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (name && name.length >= 4) SP500_NAMES.push(name);
  }
}

const BLOCKED_DOMAINS = [
  "economictimes", "indiatimes", "livemint", "moneycontrol", "business-standard",
  "ndtvprofit", "financialexpress", "thehindubusinessline", "zeebiz",
  "seekingalpha", "fool.com", "motleyfool", "zacks.com", "investorplace",
  "tipranks", "simplywall.st", "marketbeat", "insidermonkey", "247wallst",
  "benzinga.com/analyst-stock-ratings", "prnewswire", "businesswire",
  "globenewswire", "accesswire", "fxempire", "coindesk", "cointelegraph"
];

const TIER1_SOURCES = [
  "bloomberg", "reuters", "wall street journal", "wsj", "financial times", "cnbc", "sec.gov"
];
const TIER2_SOURCES = [
  "marketwatch", "barron", "the guardian", "associated press", "ap news"
];

export class MultiSourceNewsProvider {
  constructor({ marketauxKey, guardianKey, finnhubProvider, alphavantageKey }) {
    this.marketauxKey = marketauxKey;
    this.guardianKey = guardianKey;
    this.finnhub = finnhubProvider;
    this.alphavantageKey = alphavantageKey || null;
  }

  async companyNews(ticker, from, to) {
    const articles = [];

    if (this.marketauxKey) {
      try {
        const mx = await this._marketauxNews(ticker, from, to);
        articles.push(...mx);
      } catch (e) {
        console.error(`[news] marketaux ${ticker}:${e.message}`);
      }
    }

    if (articles.length === 0 && this.finnhub) {
      try {
        const fh = await this.finnhub.companyNews(ticker, from, to);
        articles.push(...fh);
      } catch (e) {
        console.error(`[news] finnhub ${ticker}:${e.message}`);
      }
    }

    for (const a of articles.slice(0, 3)) {
      if (!a.fullText && a.url) {
        a.fullText = await fetchArticleText(a.url, 4500);
      }
    }

    return articles;
  }

  _marketScore(s) {
    const headline = (s.headline || "").trim();
    const summary = (s.summary || "").trim();
    const text = (headline + " " + summary).toLowerCase();
    const src = ((s.source || "") + " " + (s.url || "")).toLowerCase();

    // 1. Hard Domain Blocklist
    for (const d of BLOCKED_DOMAINS) {
      if (src.includes(d)) return -100;
    }

    // 2. Hard Reject Patterns (Advertorials, Indian domestic/GMP IPOs, retail clickbait, crime/gossip)
    const hardRejects = [
      /\|\s*(chief financial office|cfo|sponsored|paid program|partner content|brandvoice|custom)/i,
      /\b(sponsored by|partner content|advertorial|paid post)\b/i,
      /\b(crore|lakh|rupees?|rbi|nifty|sensex|bse|nse|gmp|grey market|sebi|icici|hdfc|infosys)\b/i,
      /\b(india'?s (rupee|bop|gdp|cpi|inflation|exports|imports|trade))\b/i,
      /\b(should you apply|check gmp|subscription status|stocks? to buy|why .* stock is (moving|dropping|soaring)|here's why|single biggest risk)\b/i,
      /\b(press secretary|celebrity|kardashian|taylor swift|murder|shooting|arrested|listening device|gossip|horoscope|lottery)\b/i,
      /\b(seed round|series a|secures \$[1-9]\d?\s*m\b)/i,
    ];
    for (const re of hardRejects) {
      if (re.test(headline) || re.test(summary)) return -100;
    }

    let score = 0;

    // 3. Source Quality Tiering
    if (TIER1_SOURCES.some((t) => src.includes(t))) score += 4;
    else if (TIER2_SOURCES.some((t) => src.includes(t))) score += 2;

    // 4. Institutional Macro & Corporate Catalyst Signals (+3 each)
    const strong = [
      "s&p 500", "nasdaq", "dow jones", "federal reserve", "fed ", "fomc", "powell", "warsh",
      "ecb", "bank of japan", "boj", "treasury", "10-year", "yield", "cpi", "inflation",
      "nonfarm", "payrolls", "gdp", "pce", "retail sales", "industrial production",
      "tariff", "sanction", "earnings", "revenue", "guidance", "net income", "eps",
      "merger", "acquisition", "acquires", "buyout", "takeover", "spin-off",
      "buyback", "repurchase", "dividend", "sec ", "doj", "antitrust", "fda", "recall",
      "bankruptcy", "chapter 11", "restructuring", "layoffs"
    ];
    for (const kw of strong) {
      if (text.includes(kw)) score += 3;
    }

    // 5. Secondary Market Context (+2 each)
    const medium = [
      "wall street", "equities", "futures", "crude", "wti", "brent", "opec",
      "gold", "dollar", "currencies", "bond", "credit", "issuance", "ipo", "semiconductor"
    ];
    for (const kw of medium) {
      if (text.includes(kw)) score += 2;
    }

    // 6. Quantitative Density Bonus (+3 if headline or summary has hard figures)
    if (/(\$[\d,.]+|\d+(\.\d+)?%|\b(billion|million|trillion|bps|basis points)\b)/i.test(text)) {
      score += 3;
    }

    // 7. Full S&P 500 Ticker & Company Name Matching (+5 bonus)
    let matchedSp500 = false;
    const upperTokens = (headline + " " + summary).match(/\b[A-Z]{2,5}\b/g) || [];
    const commonWords = new Set([
      "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER", "WAS", "ONE",
      "OUR", "OUT", "DAY", "GET", "HAS", "HIM", "HIS", "HOW", "MAN", "NEW", "NOW", "OLD",
      "SEE", "TWO", "WAY", "WHO", "BOY", "DID", "ITS", "LET", "PUT", "SAY", "SHE", "TOO",
      "USE", "CEO", "CFO", "COO", "CTO", "IPO", "ETF", "FED", "SEC", "DOJ", "FDA", "GDP",
      "CPI", "PPI", "PCE", "NFP", "USD", "EUR", "JPY", "GBP", "CNY", "INR", "RBI", "ECB",
      "BOJ", "IMF", "WTO", "OPEC", "USA", "EST", "PDT", "EDT", "GMP"
    ]);
    for (const tok of upperTokens) {
      if (!commonWords.has(tok) && SP500_TICKERS.has(tok)) {
        score += 5;
        matchedSp500 = true;
        break;
      }
    }
    if (!matchedSp500) {
      for (const name of SP500_NAMES) {
        if (text.includes(name)) {
          score += 5;
          break;
        }
      }
    }

    // 8. Penalize thin headline-only items that lack both summary and fullText
    if (summary.length < 45 && (!s.fullText || s.fullText.length < 200)) {
      score -= 5;
    }

    return score;
  }

  async topNews(from, to, limit = 10) {
    const seen = new Set();
    const candidates = [];

    const addCandidate = (s) => {
      if (!s || !s.headline) return;
      const key = s.headline.slice(0, 65).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(s);
      }
    };

    // 1. Curated Institutional RSS (Bloomberg, WSJ, CNBC, MarketWatch)
    try {
      const rss = await fetchAllFeeds();
      for (const s of rss) addCandidate(s);
    } catch (e) {
      console.error(`[news] rss: ${e.message}`);
    }

    // 2. Marketaux US Entity Financial News
    if (this.marketauxKey) {
      try {
        const mx = await this._marketauxGeneral(from, to);
        for (const s of mx) addCandidate(s);
      } catch (e) {
        console.error(`[news] marketaux general: ${e.message}`);
      }
    }

    // 3. Guardian US Business/Markets (Full-text)
    if (this.guardianKey) {
      try {
        const g = await this._guardianNews();
        for (const s of g) addCandidate(s);
      } catch (e) {
        console.error(`[news] guardian: ${e.message}`);
      }
    }

    // 4. GDELT US Macro Breadth Signal
    try {
      const gd = await this._gdeltNews();
      for (const s of gd) addCandidate(s);
    } catch (e) {
      console.error(`[news] gdelt: ${e.message}`);
    }

    // 5. Alpha Vantage News Sentiment (if key supports it)
    if (this.alphavantageKey) {
      try {
        const av = await fetchNewsSentimentAV(this.alphavantageKey, { limit: 10 });
        for (const s of av) addCandidate(s);
      } catch (e) {
        console.error(`[news] alphavantage sentiment: ${e.message}`);
      }
    }

    // Score and filter candidates (require score >= 4 for institutional bar)
    const scored = candidates
      .map((s) => ({ ...s, _score: this._marketScore(s) }))
      .filter((s) => s._score >= 4)
      .sort((a, b) => b._score - a._score);

    // Cluster & Pool corroborating stories across sources BEFORE capping per-source diversity
    const clustered = this._clusterAndPool(scored);

    // Apply per-source cap (max 3 lead stories from any single primary outlet)
    const sourceCounts = {};
    const diverse = [];
    for (const s of clustered) {
      const src = (s.source || "unknown").toLowerCase();
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      if (sourceCounts[src] <= 3) {
        diverse.push(s);
      }
      if (diverse.length >= limit) break;
    }

    // Parallel full-text extraction for all winning clusters that lack fullText
    await Promise.all(
      diverse.map(async (s) => {
        if ((!s.fullText || s.fullText.length < 300) && s.url) {
          const text = await fetchArticleText(s.url, 4500);
          if (text && text.length > 200) {
            s.fullText = text;
          }
        }
        // If primary URL was paywalled, try scraping corroborating URLs in the cluster
        if ((!s.fullText || s.fullText.length < 300) && Array.isArray(s.pooledSources)) {
          for (const ps of s.pooledSources.slice(1, 3)) {
            if (ps.url) {
              const altText = await fetchArticleText(ps.url, 3500);
              if (altText && altText.length > 200) {
                s.fullText = altText;
                break;
              }
            }
          }
        }
      })
    );

    return diverse.map(({ _score, ...s }) => s);
  }

  _clusterAndPool(stories) {
    const STOP = new Set([
      "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
      "as", "at", "by", "from", "is", "are", "was", "were", "be", "been",
      "it", "its", "this", "that", "these", "those", "will", "would",
      "after", "amid", "over", "under", "up", "down", "new", "top", "latest",
      "live", "updates", "us", "says", "said", "report", "reports",
      "market", "markets", "stock", "stocks", "share", "shares",
      "investor", "investors", "trading", "wall", "street", "ahead"
    ]);

    const tokens = (str) =>
      new Set(
        (str || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t && t.length > 2 && !STOP.has(t))
          .map((t) => (t.length > 4 ? t.replace(/s$/, "") : t))
      );

    const clusters = [];
    for (const s of stories) {
      const ts = tokens(`${s.headline}${(s.summary || "").slice(0, 120)}`);
      const hTokens = tokens(s.headline);
      let matched = null;

      for (const c of clusters) {
        let hInter = 0;
        for (const t of hTokens) if (c.hTokens.has(t)) hInter++;
        const hUnion = hTokens.size + c.hTokens.size - hInter;
        const hJaccard = hUnion > 0 ? hInter / hUnion : 0;

        let fullInter = 0;
        for (const t of ts) if (c.tokens.has(t)) fullInter++;
        const fullUnion = ts.size + c.tokens.size - fullInter;
        const fullJaccard = fullUnion > 0 ? fullInter / fullUnion : 0;

        if (hJaccard >= 0.30 || fullJaccard >= 0.28) {
          matched = c;
          break;
        }
      }

      if (matched) {
        // Multi-source confirmation bonus (+3 per corroborating source, capped at +9)
        if (matched.primary.pooledSources.length < 4) {
          matched.primary._score += 3;
        }
        matched.primary.pooledSources.push({
          source: s.source || "Wire",
          headline: s.headline || "",
          summary: s.summary || "",
          fullText: s.fullText || "",
          url: s.url || "",
        });
        if (!matched.primary.fullText && s.fullText) {
          matched.primary.fullText = s.fullText;
        }
        for (const t of ts) matched.tokens.add(t);
      } else {
        s.pooledSources = [
          {
            source: s.source || "Wire",
            headline: s.headline || "",
            summary: s.summary || "",
            fullText: s.fullText || "",
            url: s.url || "",
          },
        ];
        clusters.push({ primary: s, hTokens, tokens: ts });
      }
    }

    return clusters
      .map((c) => c.primary)
      .sort((a, b) => b._score - a._score);
  }

  async _marketauxNews(ticker, from, to) {
    const url =
      `https://api.marketaux.com/v1/news/all` +
      `?symbols=${encodeURIComponent(ticker)}` +
      `&countries=us&filter_entities=true&language=en` +
      `&api_token=${this.marketauxKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`marketaux ${res.status}`);
    const data = await res.json();
    return (data.data || [])
      .map((a) => ({
        datetime: a.published_at ? Date.parse(a.published_at) / 1000 : 0,
        headline: (a.title || "").trim(),
        source: (a.source || "").trim(),
        summary: (a.description || a.snippet || "").trim(),
        url: a.url || "",
        image: a.image_url || "",
        sentiment: a.entities?.[0]?.sentiment_score ?? null,
        fullText: "",
      }))
      .filter((a) => a.headline);
  }

  async _marketauxGeneral(from, to) {
    const url =
      `https://api.marketaux.com/v1/news/all` +
      `?countries=us&language=en&must_have_entities=true&limit=25` +
      `&api_token=${this.marketauxKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`marketaux ${res.status}`);
    const data = await res.json();
    return (data.data || [])
      .map((a) => ({
        datetime: a.published_at ? Date.parse(a.published_at) / 1000 : 0,
        headline: (a.title || "").trim(),
        source: (a.source || "").trim(),
        summary: (a.description || a.snippet || "").trim(),
        url: a.url || "",
        image: a.image_url || "",
        fullText: "",
      }))
      .filter((a) => a.headline);
  }

  async _gdeltNews() {
    const query = encodeURIComponent(
      "(S&P 500 OR Federal Reserve OR Treasury yields OR corporate earnings) sourcelang:english sourcecountry:US"
    );
    const url =
      `https://api.gdeltproject.org/api/v2/doc/doc` +
      `?query=${query}&mode=artlist&format=json&maxrecords=15&sort=date&timespan=1d`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`gdelt ${res.status}`);
    const text = await res.text();
    if (!text.trim().startsWith("{")) throw new Error("gdelt rate-limited");
    const data = JSON.parse(text);
    return (data.articles || [])
      .filter((a) => a.language === "English" || !a.language)
      .map((a) => ({
        datetime: a.seendate
          ? Date.parse(
              a.seendate.replace(
                /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
                "$1-$2-$3T$4:$5:$6Z"
              )
            ) / 1000
          : 0,
        headline: (a.title || "").trim(),
        source: (a.domain || "").trim(),
        summary: "",
        url: a.url || "",
        image: a.socialimage || "",
        fullText: "",
      }))
      .filter((a) => a.headline);
  }

  async _guardianNews() {
    const url =
      `https://content.guardianapis.com/search` +
      `?section=business&q=markets` +
      `&production-office=US` +
      `&show-fields=bodyText,trailText,thumbnail` +
      `&page-size=10&order-by=newest` +
      `&api-key=${this.guardianKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`guardian ${res.status}`);
    const data = await res.json();
    return (data.response?.results || [])
      .map((a) => ({
        datetime: a.webPublicationDate ? Date.parse(a.webPublicationDate) / 1000 : 0,
        headline: (a.webTitle || "").trim(),
        source: "The Guardian",
        summary: (a.fields?.trailText || "").replace(/<[^>]+>/g, "").trim(),
        url: a.webUrl || "",
        image: a.fields?.thumbnail || "",
        fullText: (a.fields?.bodyText || "").slice(0, 4000),
      }))
      .filter((a) => a.headline);
  }
}
