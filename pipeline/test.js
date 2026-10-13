// Minimal tests for clean pipeline
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { MockSummarizer } from "./lib/summarize.js";
import { MockMarketProvider } from "./lib/market.js";
import { MOCK_MARKET } from "./lib/mock-data.js";
import { runMarket, runAssemble, runStage } from "./stages.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nowSec = () => Math.floor(Date.now() / 1000);

function openDB() {
  const sqlite = new DatabaseSync(":memory:");
  const wrap = (stmt) => ({
    bind: (...p) => ({
      first: () => stmt.get(...p) ?? null,
      all: () => ({ results: stmt.all(...p) }),
      run: () => {
        const r = stmt.run(...p);
        return { success: true, meta: { changes: r.changes ?? 0 } };
      },
    }),
    first: () => stmt.get() ?? null,
    all: () => ({ results: stmt.all() }),
    run: (...p) => {
      const r = stmt.run(...p);
      return { success: true, meta: { changes: r.changes ?? 0 } };
    },
  });
  return {
    prepare: (sql) => wrap(sqlite.prepare(sql)),
    exec: (sql) => sqlite.exec(sql),
  };
}

async function freshDB() {
  const db = openDB();
  const strip = (t) => t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  for (const f of ["schema.sql", "pipeline/schema-additions.sql"]) {
    try {
      const sql = strip(await readFile(path.join(root, f), "utf8"));
      for (const s of sql.split(";")) if (s.trim()) db.exec(s);
    } catch (e) {
      // file may not exist, skip
    }
  }
  return db;
}

async function seedUser(db, { id, email, name }) {
  await db.prepare(
    "INSERT INTO users (id, email, first_name, plan, created_at) VALUES (?, ?, ?, 'free', ?)"
  ).bind(id, email, name, nowSec()).run();
}

test("runStage: claims once, skips when done", async () => {
  const db = await freshDB();
  let calls = 0;
  const r1 = await runStage(db, "2026-10-12", "test", async () => { calls++; return { ok: 1 }; }, nowSec);
  assert.equal(calls, 1);
  const r2 = await runStage(db, "2026-10-12", "test", async () => { calls++; return { ok: 1 }; }, nowSec);
  assert.equal(calls, 1); // skipped
  assert.ok(r2.alreadyDone);
});

test("assemble: sends brief", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });

  const sent = [];
  const sender = { send: async (m) => (sent.push(m), { ok: true }) };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r1 = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r1.sent, 1); // only subscribed
  assert.match(sent[0].html, /not investment advice/i);
});
