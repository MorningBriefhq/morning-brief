// RSS feed parsers for high-quality institutional financial news discovery.
// These curated feeds establish what matters in US capital markets.

const FEEDS = {
  bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
  wsj_markets: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
  cnbc_top: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  cnbc_finance: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
  cnbc_economy: "https://www.cnbc.com/id/20910258/device/rss/rss.html",
  cnbc_earnings: "https://www.cnbc.com/id/15839135/device/rss/rss.html",
  marketwatch: "https://feeds.marketwatch.com/marketwatch/topstories/",
};

const SOURCE_LABELS = {
  bloomberg: "Bloomberg",
  wsj_markets: "Wall Street Journal",
  cnbc_top: "CNBC",
  cnbc_finance: "CNBC",
  cnbc_economy: "CNBC",
  cnbc_earnings: "CNBC",
  marketwatch: "MarketWatch",
};

const UA = "Mozilla/5.0 (compatible; MorningBrief/1.0)";

function parseRSS(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const f = r.exec(block);
      if (!f) return "";
      let t = f[1].trim();
      t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
      t = t
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x2019;/gi, "'")
        .replace(/&#x2014;/gi, "—");
      t = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return t;
    };
    const title = get("title");
    if (!title) continue;
    items.push({
      headline: title,
      source: "",
      summary: get("description"),
      url: get("link"),
      datetime: get("pubDate") ? Date.parse(get("pubDate")) / 1000 : 0,
      image: "",
      fullText: "",
    });
  }
  return items;
}

export async function fetchFeed(name) {
  const url = FEEDS[name];
  if (!url) throw new Error(`unknown feed: ${name}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) throw new Error(`${name} RSS${res.status}`);
  const xml = await res.text();
  const items = parseRSS(xml);
  const sourceName = SOURCE_LABELS[name] || name;
  for (const i of items) i.source = i.source || sourceName;
  return items;
}

export async function fetchAllFeeds() {
  const all = [];
  const seen = new Set();
  const feedNames = Object.keys(FEEDS);

  const results = await Promise.allSettled(
    feedNames.map((name) => fetchFeed(name))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      for (const item of r.value) {
        const key = item.headline.slice(0, 65).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          all.push(item);
        }
      }
    } else {
      console.error(`[rss] ${feedNames[i]}:${r.reason?.message || r.reason}`);
    }
  }

  all.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  return all;
}
