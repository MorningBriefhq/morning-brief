// Morning Brief pipeline — local end-to-end harness (mock mode).
//
// Runs the full pipeline against an in-memory SQLite DB shaped like D1,
// with mock news/summarizer/market providers and rendered emails written to
// pipeline/outbox/ instead of sent.
//
// Usage:
//   node pipeline/local-run.js [--date=YYYY-MM-DD] [--full] [--outbox=dir]
//     --date   override the ET run date (default: today in America/New_York)
//     --full   ingest the whole S&P 500 universe instead of held tickers
//     --outbox output dir (default: pipeline/outbox)
//
// Verifies: ingest -> summarize (once per ticker) -> market -> assemble,
// quiet-ticker skipping, unsubscribed-user skipping, idempotent re-runs.

import { DatabaseSync } from "node:sqlite";
import { readFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDateET, dateLongET } from "./lib/time.js";
import { MockNewsProvider } from "./lib/news.js";
import { MockSummarizer } from "./lib/summarize.js";
import { MockMarketProvider } from "./lib/market.js";
import { FileOutboxSender } from "./lib/send.js";
import { MOCK_ARTICLES, MOCK_MARKET } from "./lib/mock-data.js";
import {
  getTargetTickers,
  runIngest,
  runIngestFull,
  runSummarize,
  runMarket,
  runAssemble,
} from "./stages.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- D1-shaped shim over node:sqlite ----------
function openTestDB() {
  const sqlite = new DatabaseSync(":memory:");
  const wrap = (stmt) => ({
    bind(...params) {
      return {
        first: () => stmt.get(...params) ?? null,
        all: () => ({ results: stmt.all(...params) }),
        run: () => {
          stmt.run(...params);
          return { success: true };
        },
      };
    },
    // D1 allows .first()/.all()/.run() with no bind() call.
    first: () => stmt.get() ?? null,
    all: () => ({ results: stmt.all() }),
    run: () => {
      stmt.run();
      return { success: true };
    },
  });
  return {
    prepare(sql) {
      return wrap(sqlite.prepare(sql));
    },
    _raw: sqlite,
  };
}

function applySql(db, sqlText) {
  const stripped = sqlText
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  for (const stmt of stripped.split(";")) {
    const s = stmt.trim();
    if (s) db._raw.exec(s);
  }
}

// ---------- seed ----------
async function seed(db) {
  const users = [
    { id: "u-pat", email: "pat@example.com", first_name: "Pat", tickers: ["NVDA", "AAPL", "JPM", "TSLA"] },
    { id: "u-dana", email: "dana@example.com", first_name: "Dana", tickers: ["MSFT", "AMZN", "KO"] }, // KO: no mock news -> quiet skip
    { id: "u-skip", email: "skip@example.com", first_name: "Skip", tickers: ["XOM"], unsub: true },
  ];
  for (const u of users) {
    await db
      .prepare("INSERT INTO users (id, email, first_name, plan, created_at, unsubscribed_at) VALUES (?, ?, ?, 'free', ?, ?)")
      .bind(u.id, u.email, u.first_name, nowSec(), u.unsub ? nowSec() : null)
      .run();
    for (const t of u.tickers) {
      await db
        .prepare("INSERT INTO user_tickers (user_id, ticker, added_at) VALUES (?, ?, ?)")
        .bind(u.id, t, nowSec())
        .run();
    }
  }
  return users;
}

// ---------- main ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(=(.*))?$/);
    return [m[1], m[3] ?? true];
  })
);

const runDate = args.date || runDateET(new Date());
const outboxDir = args.outbox === true ? path.join(root, "pipeline", "outbox") : path.join(root, "pipeline", String(args.outbox || "outbox"));
const fullMode = args.full === true || args.full === "true";

const db = openTestDB();
applySql(db, await readFile(path.join(root, "schema.sql"), "utf8"));
applySql(db, await readFile(path.join(root, "pipeline", "schema-additions.sql"), "utf8"));
// Numbered migrations, in order (see pipeline/migrations/README.md).
for (const m of (await readdir(path.join(root, "pipeline", "migrations"))).filter((f) => f.endsWith(".sql")).sort()) {
  applySql(db, await readFile(path.join(root, "pipeline", "migrations", m), "utf8"));
}
await seed(db);

const sp500 = JSON.parse(await readFile(path.join(root, "data", "sp500.json"), "utf8"));
const companyByTicker = new Map(sp500.stocks.map((s) => [s.ticker, s.name]));
const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");

const news = new MockNewsProvider(MOCK_ARTICLES);
const summarizer = new MockSummarizer();
const market = new MockMarketProvider(MOCK_MARKET);
const { writeFile } = await import("node:fs/promises");
const sender = new FileOutboxSender(outboxDir, { mkdir, writeFile });

const from = runDate; // mock provider ignores the window
const to = runDate;

// 1) ingest
let withNews;
if (fullMode) {
  const universe = sp500.stocks.map((s) => s.ticker);
  const r = await runIngestFull({ db, news, universe, runDate, from, to, nowSec: nowSec, chunkSize: 503 });
  const { results } = await db
    .prepare("SELECT ticker FROM ticker_news_raw WHERE run_date = ? AND article_count > 0")
    .bind(runDate)
    .all();
  withNews = results;
  console.log(`[ingest] full universe: ${universe.length} tickers, done=${r.done}`);
} else {
  const tickers = await getTargetTickers(db);
  withNews = await runIngest({ db, news, tickers, runDate, from, to, nowSec: nowSec });
  console.log(`[ingest] held tickers: ${tickers.join(", ") || "(none)"}`);
}
console.log(`[ingest] tickers with news: ${withNews.map((t) => t.ticker).join(", ") || "(none)"}`);

// 2) summarize (once per ticker per day)
const sum = await runSummarize({ db, summarizer, runDate, items: withNews, companyByTicker, nowSec: nowSec });
console.log(`[summarize] generated=${sum.generated} skipped=${sum.skipped}`);

// 3) market overview
await runMarket({ db, market, runDate, nowSec: nowSec });
console.log("[market] sections stored");

// 4) assemble + "send" to outbox
const asm = await runAssemble({
  db,
  sender,
  runDate,
  dateLong: dateLongET(new Date(`${runDate}T12:00:00Z`)),
  origin: "http://localhost:8080",
  productName: "Morning Brief",
  sessionSecret: "local-dev-secret",
  templateText,
  nowSec: nowSec,
});
console.log(`[assemble] users=${asm.users} sent=${asm.sent} skipped=${asm.skipped} -> ${outboxDir}`);

// 5) idempotency check: run summarize + assemble again, expect no new work
const sum2 = await runSummarize({ db, summarizer, runDate, items: withNews, companyByTicker, nowSec: nowSec });
const asm2 = await runAssemble({
  db, sender, runDate,
  dateLong: dateLongET(new Date(`${runDate}T12:00:00Z`)),
  origin: "http://localhost:8080", productName: "Morning Brief",
  sessionSecret: "local-dev-secret", templateText, nowSec: nowSec,
});
console.log(`[idempotency] re-run summarize generated=${sum2.generated} (expect 0), assemble sent=${asm2.sent} skipped=${asm2.skipped} (expect 0 sent)`);

if (sum2.generated !== 0 || asm2.sent !== 0) {
  console.error("IDEMPOTENCY CHECK FAILED");
  process.exit(1);
}
console.log("OK — pipeline ran end-to-end in mock mode.");
