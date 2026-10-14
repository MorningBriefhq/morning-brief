// Morning Brief pipeline — news providers.
//
// Interface: companyNews(ticker, from, to) -> [{datetime, headline, source,
// summary, url}] for the overnight window. `from`/`to` are "YYYY-MM-DD".
//
// FinnhubNewsProvider: real data, needs FINNHUB_API_KEY (free tier: 60 calls/min,
// company-news endpoint included). MockNewsProvider: canned data for testing,
// returns [] for tickers with no mock articles (quiet tickers are skipped).

export class NewsProvider {
  async companyNews(_ticker, _from, _to) {
    throw new Error("NewsProvider.companyNews not implemented");
  }
}

export class FinnhubNewsProvider extends NewsProvider {
  constructor(apiKey) {
    super();
    this.apiKey = apiKey;
  }
  async companyNews(ticker, from, to) {
    const url =
      "https://finnhub.io/api/v1/company-news" +
      `?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`finnhub company-news ${res.status} for ${ticker}`);
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : [])
      .map((a) => ({
        datetime: a.datetime || 0,
        headline: (a.headline || "").trim(),
        source: (a.source || "").trim(),
        summary: (a.summary || "").trim(),
        url: a.url || "",
      }))
      .filter((a) => a.headline);
  }
}

export class MockNewsProvider extends NewsProvider {
  // mockData: { TICKER: [{datetime, headline, source, summary, url}] }
  constructor(mockData) {
    super();
    this.mockData = mockData || {};
  }
  async companyNews(ticker /*, _from, _to */) {
    return (this.mockData[ticker] || []).map((a) => ({ ...a }));
  }
}
