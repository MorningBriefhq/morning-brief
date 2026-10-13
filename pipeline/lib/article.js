// Article text extractor — fetches full text from news URLs.
// Used to get real content for AI summarization (Finnhub only gives headlines).

/**
 * Extract readable text from HTML. Simple heuristic: find <p> tags,
 * filter out short/nav/caption paragraphs, join the rest.
 */
export function extractText(html) {
  if (!html || typeof html !== "string") return "";
  // Remove script, style, nav, header, footer, aside
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  // Extract paragraphs
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let p = m[1]
      .replace(/<[^>]+>/g, " ") // strip inner tags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    // Filter: must be substantial, not a caption/byline
    if (p.length > 80 && !/^(photo|image|credit|by |reuters\/|associated press)/i.test(p)) {
      paras.push(p);
    }
  }
  return paras.slice(0, 12).join("\n\n").slice(0, 4000); // cap at 4000 chars
}

/**
 * Fetch article text from URL with timeout. Returns "" on failure.
 */
export async function fetchArticleText(url, timeoutMs = 8000) {
  if (!url || !url.startsWith("http")) return "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MorningBrief/1.0)",
        "Accept": "text/html",
      },
    });
    clearTimeout(t);
    if (!res.ok) return "";
    const html = await res.text();
    return extractText(html);
  } catch (e) {
    return "";
  }
}
