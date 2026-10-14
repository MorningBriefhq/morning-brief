// SEC EDGAR 8-K filings — "what companies did/said/announced."
//
// Free, no key. 8-Ks are the authoritative source for corporate actions:
// earnings releases, guidance, M&A, leadership changes, material agreements.
// This is exactly Pat's "Stocks to Watch" definition.
//
// Approach: for each ticker, fetch the company's recent filings from
// data.sec.gov/submissions, filter for 8-K/8-K/A filed in the last N days,
// then pull the primary document and extract Item headings.
//
// SEC requires a User-Agent with contact info. Rate limit: 10 req/sec.
// We check the top ~75 S&P 500 names (the ones that move markets) in
// parallel batches to stay fast.

import { TICKER_CIK } from "./edgar-ciks.js";

const UA = "MorningBrief/1.0 contact@morningbrief.link";

// 8-K item numbers -> plain-English category.
// Only the items that matter for "what the company announced."
const ITEM_LABELS = {
  "1.01": "Material agreement",
  "1.02": "Terminated agreement",
  "1.03": "Bankruptcy/receivership",
  "2.01": "Acquisition/disposition completed",
  "2.02": "Earnings results",
  "2.03": "Off-balance-sheet arrangement",
  "2.04": "Triggering events (debt default)",
  "2.05": "Exit/disposal costs",
  "2.06": "Material impairment",
  "3.01": "Delisting notice",
  "3.02": "Unregistered securities sale",
  "3.03": "Material modification of shareholder rights",
  "4.01": "Auditor change",
  "4.02": "Non-reliance on financials",
  "5.01": "Change in control",
  "5.02": "Leadership change",
  "5.03": "Charter/bylaw amendment",
  "5.04": "Trading suspension",
  "5.05": "Ethics code amendment",
  "5.06": "Shell company change",
  "5.07": "Shareholder vote results",
  "5.08": "Other shareholder matters",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other material event",
};

// Items worth surfacing in Stocks to Watch (skip pure housekeeping).
const NOTABLE_ITEMS = new Set([
  "1.01", "1.02", "2.01", "2.02", "2.05", "2.06",
  "3.01", "4.01", "4.02", "5.01", "5.02", "5.07",
  "7.01", "8.01",
]);

async function _fetch(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`edgar ${res.status} for ${url.slice(0, 80)}`);
  return res;
}

/** Extract Item X.XX headings from an 8-K primary document. */
function _extractItems(htmlText) {
  // Strip scripts/styles/tags, keep text
  let text = htmlText.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ");
  // XBRL filings embed item refs in context tags — strip those to avoid noise
  text = text.replace(/\b[a-z]+:?[A-Za-z]*Member\b/g, " ");
  const items = [];
  const seen = new Set();
  // Simple: find all "Item X.XX" references. The 8-K body lists each item once
  // as a heading; duplicates from TOC are deduped by `seen`.
  const re = /Item\s+(\d+\.\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = m[1];
    if (seen.has(num) || !NOTABLE_ITEMS.has(num)) continue;
    seen.add(num);
    items.push({ item: num, label: ITEM_LABELS[num] || "Corporate action" });
  }
  return items;
}

/** Pull a short excerpt from the 8-K body (first substantive paragraph). */
function _extractExcerpt(htmlText, maxLen = 400) {
  let text = htmlText.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Prefer paragraph text
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(htmlText)) !== null && paras.length < 20) {
    let p = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (p.length > 80) paras.push(p);
  }
  if (paras.length > 0) {
    return paras.join(" ").slice(0, maxLen).trim();
  }
  // Fallback for XBRL-heavy filings: first substantive text after tag strip.
  // Skip the XBRL context block (long runs of Member/contextRef tokens).
  let flat = htmlText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  flat = flat.replace(/^([\w:.-]+Member\s+){5,}/, ""); // strip XBRL member runs
  // Find the first sentence-like chunk over 60 chars
  const sentences = flat.split(/(?<=[.!?])\s+/).filter((s) => {
    const t = s.trim();
    return t.length > 60 && !/^[0-9a-f-]{20,}$/i.test(t) && (t.match(/[a-z]/g) || []).length > 20;
  });
  return (sentences[0] || "").slice(0, maxLen).trim();
}

/**
 * Fetch recent 8-K filings for S&P 500 companies.
 *
 * @param {object} opts
 * @param {string[]} opts.tickers - tickers to check (defaults to top 75 S&P 500)
 * @param {number} opts.daysBack - how far back to look (default 3)
 * @param {number} opts.maxFilings - cap on detailed filing fetches (default 12)
 * @returns {Promise<Array>} [{ticker, company, filedDate, items:[{item,label}], excerpt, filingUrl}]
 */
export async function fetchRecent8Ks({ tickers = null, daysBack = 3, maxFilings = 12 } = {}) {
  const { SP500 } = await import("./sp500.js");
  const checkTickers = tickers || SP500.slice(0, 75).map((s) => s.ticker);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Step 1: find recent 8-Ks (parallel, batched to respect SEC rate limits)
  const candidates = [];
  const batchSize = 10;
  for (let i = 0; i < checkTickers.length; i += batchSize) {
    const batch = checkTickers.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (ticker) => {
        const cik = TICKER_CIK[ticker];
        if (!cik) return [];
        try {
          const res = await _fetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
          const data = await res.json();
          const rec = data.filings?.recent;
          if (!rec) return [];
          const out = [];
          for (let j = 0; j < rec.form.length; j++) {
            const form = rec.form[j];
            if (form !== "8-K" && form !== "8-K/A") continue;
            const filed = rec.filingDate[j];
            if (filed < cutoffStr) break; // recent is newest-first
            const accession = rec.accessionNumber[j].replace(/-/g, "");
            out.push({ ticker, cik, filedDate: filed, accession, form });
          }
          return out;
        } catch (e) {
          console.error(`[edgar] ${ticker}: ${e.message}`);
          return [];
        }
      })
    );
    for (const r of results) candidates.push(...r);
    // Small delay between batches for SEC rate limits
    if (i + batchSize < checkTickers.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Most recent first, cap detail fetches
  candidates.sort((a, b) => b.filedDate.localeCompare(a.filedDate));
  const toDetail = candidates.slice(0, maxFilings);

  // Step 2: pull item headings + excerpt for each
  const filings = [];
  for (const c of toDetail) {
    try {
      const idxRes = await _fetch(
        `https://www.sec.gov/Archives/edgar/data/${parseInt(c.cik, 10)}/${c.accession}/index.json`
      );
      const idx = await idxRes.json();
      const items = idx.directory?.item || [];
      // Primary 8-K doc: the main filing document.
      // Exclude: index files, XBRL reports (R1.htm, R2.htm...), image exhibits.
      // Prefer the doc whose name matches the ticker or looks like the main filing.
      const docs = items.filter(
        (it) =>
          /\.htm$/i.test(it.name) &&
          !/index/i.test(it.name) &&
          !/^R\d+\.htm$/i.test(it.name) // XBRL viewer reports
      );
      // Prefer a doc with the ticker in the name, else the largest remaining
      const tickerRe = new RegExp(c.ticker.replace(".", ""), "i");
      docs.sort((a, b) => {
        const aTick = tickerRe.test(a.name) ? 1 : 0;
        const bTick = tickerRe.test(b.name) ? 1 : 0;
        if (aTick !== bTick) return bTick - aTick;
        return (parseInt(b.size) || 0) - (parseInt(a.size) || 0);
      });
      const primary = docs[0];
      if (!primary) continue;
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(c.cik, 10)}/${c.accession}/${primary.name}`;
      const docRes = await _fetch(docUrl);
      const htmlText = await docRes.text();
      const itemHeadings = _extractItems(htmlText);
      if (itemHeadings.length === 0) continue; // nothing notable
      const sp = SP500.find((s) => s.ticker === c.ticker);
      filings.push({
        ticker: c.ticker,
        company: sp?.name || c.ticker,
        filedDate: c.filedDate,
        form: c.form,
        items: itemHeadings,
        excerpt: _extractExcerpt(htmlText),
        filingUrl: docUrl,
        source: "SEC EDGAR",
      });
    } catch (e) {
      console.error(`[edgar] detail ${c.ticker} ${c.accession}: ${e.message}`);
    }
  }

  console.log(`[edgar] ${filings.length} notable 8-Ks from ${checkTickers.length} tickers checked (last ${daysBack}d)`);
  return filings;
}
