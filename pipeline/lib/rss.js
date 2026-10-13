// RSS feed parsers for high-quality financial news discovery.
// These are CURATED sources — they tell us what matters.
// We use them for story discovery, then get depth from Marketaux/Guardian.

const FEEDS = {
  bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
  marketwatch: "https://feeds.marketwatch.com/marketwatch/topstories/",
  cnbc: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
};

const UA = "Mozilla/5.0 (compatible; MorningBrief/1.0)";

function parseRSS(xml) {
  const items = [];
  // Simple regex-based parsing (RSS is predictable enough)
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const f = r.exec(block);
      if (!f) return "";
      let t = f[1].trim();
      // Strip CDATA
      t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
      // Decode common entities
      t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
           .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
      // Strip HTML tags from descriptions
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
    headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml" },
  });
  if (!res.ok) throw new Error(`${name} RSS ${res.status}`);
  const xml = await res.text();
  const items = parseRSS(xml);
  // Tag source
  const sourceName = { bloomberg: "Bloomberg", marketwatch: "MarketWatch", cnbc: "CNBC" }[name] || name;
  for (const i of items) i.source = i.source || sourceName;
  return items;
}

export async function fetchAllFeeds() {
  const all = [];
  const seen = new Set();
  for (const name of Object.keys(FEEDS)) {
    try {
      const items = await fetchFeed(name);
      for (const item of items) {
        const key = item.headline.slice(0, 60).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          all.push(item);
        }
      }
    } catch (e) {
      console.error(`[rss] ${name}: ${e.message}`);
    }
  }
  // Sort by recency
  all.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  return all;
}
