// Multi-source news provider — best of breed.
// Combines multiple free APIs, each for what it does best:
// - Marketaux: financial news with sentiment per ticker
// - Guardian: full-text articles for deep dives
// - Finnhub: fallback headlines + market data (existing)
// - Article scraper: full text from any URL as last resort

import { fetchArticleText } from "./article.js";
import { fetchAllFeeds } from "./rss.js";

export class MultiSourceNewsProvider {
  constructor({ marketauxKey, guardianKey, finnhubProvider }) {
    this.marketauxKey = marketauxKey;
    this.guardianKey = guardianKey;
    this.finnhub = finnhubProvider;
  }

  /**
   * Get news for a ticker, enriched with best available content.
   * Returns articles with: headline, source, summary, url, sentiment, fullText
   */
  async companyNews(ticker, from, to) {
    const articles = [];

    // 1. Marketaux: financial news with sentiment (primary)
    if (this.marketauxKey) {
      try {
        const mx = await this._marketauxNews(ticker, from, to);
        articles.push(...mx);
      } catch (e) {
        console.error(`[news] marketaux ${ticker}: ${e.message}`);
      }
    }

    // 2. Finnhub fallback: headlines (existing behavior)
    if (articles.length === 0 && this.finnhub) {
      try {
        const fh = await this.finnhub.companyNews(ticker, from, to);
        articles.push(...fh);
      } catch (e) {
        console.error(`[news] finnhub ${ticker}: ${e.message}`);
      }
    }

    // 3. Enrich top articles with full text for AI summarization
    // Only fetch for top 3 to keep it fast
    for (const a of articles.slice(0, 3)) {
      if (!a.fullText && a.url) {
        a.fullText = await fetchArticleText(a.url);
      }
    }

    return articles;
  }

  /**
   * Get top market news (not ticker-specific) from multiple sources.
   */
  // Market relevance keywords — stories must match to be included
  _marketScore(s) {
    const text = ((s.headline || "") + " " + (s.summary || "")).toLowerCase();
    let score = 0;

    // Strong market signals (+3 each)
    const strong = [
      "s&p", "nasdaq", "dow jones", "federal reserve", "fed ", "ecb", "boj",
      "interest rate", "inflation", "cpi", "payrolls", "gdp", "treasury",
      "earnings", "revenue", "profit", "guidance", "upgrade", "downgrade",
      "merger", "acquisition", "ipo", "buyback", "dividend",
    ];
    for (const kw of strong) {
      if (text.includes(kw)) score += 3;
    }

    // Market context (+2 each)
    const medium = [
      "stock", "share", "market", "investor", "trading", "wall street",
      "oil", "gold", "bitcoin", "crypto", "bond", "yield", "dollar",
      "recession", "stimulus", "tariff", "trade war",
    ];
    for (const kw of medium) {
      if (text.includes(kw)) score += 2;
    }

    // S&P 500 tickers mentioned (+5 — very relevant)
    const sp500Tickers = ["aapl", "msft", "nvda", "amzn", "meta", "googl", "tsla", "avgo", "jpm", "bac", "xom", "unh", "wmt"];
    for (const t of sp500Tickers) {
      if (text.includes(t)) score += 5;
    }

    // Junk filters (-10 each — exclude these)
    const junk = [
      "press secretary", "arrested", "listening device", "gossip", "celebrity",
      "kardashian", "taylor swift", "arrest", "murder", "shooting",
      "secures $", "seed round", "series a", // tiny private companies
    ];
    for (const kw of junk) {
      if (text.includes(kw)) score -= 10;
    }

    return score;
  }

  async topNews(from, to, limit = 12) {
    const seen = new Set();
    const candidates = [];

    // Collect from ALL sources first
    // Marketaux general financial news
    if (this.marketauxKey) {
      try {
        const mx = await this._marketauxGeneral(from, to);
        for (const s of mx) {
          const key = (s.headline || "").slice(0, 60).toLowerCase();
          if (!seen.has(key) && s.headline) {
            seen.add(key);
            candidates.push(s);
          }
        }
      } catch (e) {
        console.error(`[news] marketaux general: ${e.message}`);
      }
    }

    // Guardian for full-text depth
    if (this.guardianKey) {
      try {
        const g = await this._guardianNews();
        for (const s of g) {
          const key = (s.headline || "").slice(0, 60).toLowerCase();
          if (!seen.has(key) && s.headline) {
            seen.add(key);
            candidates.push(s);
          }
        }
      } catch (e) {
        console.error(`[news] guardian: ${e.message}`);
      }
    }

    // RSS: Bloomberg, MarketWatch, CNBC
    try {
      const rss = await fetchAllFeeds();
      for (const s of rss) {
        const key = (s.headline || "").slice(0, 60).toLowerCase();
        if (!seen.has(key) && s.headline) {
          seen.add(key);
          candidates.push(s);
        }
      }
    } catch (e) {
      console.error(`[news] rss: ${e.message}`);
    }

    // Score and filter: only market-relevant stories
    const scored = candidates
      .map((s) => ({ ...s, _score: this._marketScore(s) }))
      .filter((s) => s._score > 0) // Must have positive market relevance
      .sort((a, b) => b._score - a._score);

    // Per-source cap for diversity: no single source dominates the brief.
    // (Previously a fullText-preference sort buried Marketaux/RSS under
    // Guardian every time, since Guardian always ships bodyText.)
    const sourceCounts = {};
    const diverse = [];
    for (const s of scored) {
      const src = (s.source || "unknown").toLowerCase();
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      if (sourceCounts[src] <= 3) diverse.push(s);
      if (diverse.length >= limit) break;
    }

    return diverse.map(({ _score, ...s }) => s);
  }

  async _marketauxNews(ticker, from, to) {
    const url =
      `https://api.marketaux.com/v1/news/all` +
      `?symbols=${encodeURIComponent(ticker)}` +
      `&filter_entities=true&language=en` +
      `&api_token=${this.marketauxKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`marketaux ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((a) => ({
      datetime: a.published_at ? Date.parse(a.published_at) / 1000 : 0,
      headline: (a.title || "").trim(),
      source: (a.source || "").trim(),
      summary: (a.description || a.snippet || "").trim(),
      url: a.url || "",
      image: a.image_url || "",
      sentiment: a.entities?.[0]?.sentiment_score ?? null,
      fullText: "", // enriched later
    })).filter((a) => a.headline);
  }

  async _marketauxGeneral(from, to) {
    const url =
      `https://api.marketaux.com/v1/news/all` +
      `?language=en&limit=20` +
      `&api_token=${this.marketauxKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`marketaux ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((a) => ({
      datetime: a.published_at ? Date.parse(a.published_at) / 1000 : 0,
      headline: (a.title || "").trim(),
      source: (a.source || "").trim(),
      summary: (a.description || a.snippet || "").trim(),
      url: a.url || "",
      image: a.image_url || "",
      fullText: "",
    })).filter((a) => a.headline);
  }

  async _guardianNews() {
    // production-office=US: without this the API defaults to UK edition,
    // which is why the brief was full of UK budget/FTSE stories.
    const url =
      `https://content.guardianapis.com/search` +
      `?section=business&q=markets` +
      `&production-office=US` +
      `&show-fields=bodyText,thumbnail` +
      `&page-size=10&order-by=newest` +
      `&api-key=${this.guardianKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`guardian ${res.status}`);
    const data = await res.json();
    return (data.response?.results || []).map((a) => ({
      datetime: a.webPublicationDate ? Date.parse(a.webPublicationDate) / 1000 : 0,
      headline: (a.webTitle || "").trim(),
      source: "The Guardian",
      summary: "",
      url: a.webUrl || "",
      image: a.fields?.thumbnail || "",
      fullText: (a.fields?.bodyText || "").slice(0, 4000),
    })).filter((a) => a.headline);
  }
}
