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
  const files = ["schema.sql", "pipeline/schema-additions.sql"];
  // Numbered migrations, in order (see pipeline/migrations/README.md).
  try {
    const migDir = path.join(root, "pipeline", "migrations");
    const { readdir } = await import("node:fs/promises");
    const migs = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const m of migs) files.push(path.join("pipeline", "migrations", m));
  } catch (e) {
    // no migrations dir yet, skip
  }
  for (const f of files) {
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

test("assemble: suppressions excluded from send", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await seedUser(db, { id: "u2", email: "bounce@x.com", name: "Bounced" });
  await db.prepare(
    "INSERT INTO suppressions (email, reason, created_at) VALUES (?, 'bounce', ?)"
  ).bind("bounce@x.com", nowSec()).run();
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });

  const sent = [];
  const sender = { send: async (m) => (sent.push(m), { ok: true }) };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "pat@x.com");
  const { results: rows } = await db.prepare("SELECT user_id, status FROM email_sends").all();
  assert.equal(rows.length, 1); // no claim row for the suppressed address
});

test("assemble: batch send carries List-Unsubscribe headers", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await seedUser(db, { id: "u2", email: "dana@x.com", name: "Dana" });
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });

  const batches = [];
  const sender = {
    sendBatch: async (messages) => {
      batches.push(messages);
      return messages.map((m) => ({ ok: true, to: m.to, id: "batch-id" }));
    },
    send: async () => { throw new Error("serial should not be used when batch succeeds"); },
  };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r.sent, 2);
  assert.equal(batches.length, 1); // one batch call for both recipients
  assert.equal(batches[0].length, 2);
  for (const m of batches[0]) {
    assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/example\.com\/api\/unsubscribe\?token=/);
    assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  }
  // Per-recipient unsubscribe URLs differ (token is per user).
  assert.notEqual(batches[0][0].headers["List-Unsubscribe"], batches[0][1].headers["List-Unsubscribe"]);
});

test("assemble: serial fallback when batch fails", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });

  const serial = [];
  const sender = {
    sendBatch: async () => { throw new Error("batch exploded"); },
    send: async (m) => (serial.push(m), { ok: true }),
  };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r.sent, 1);
  assert.equal(serial.length, 1);
  assert.match(serial[0].headers["List-Unsubscribe"], /unsubscribe\?token=/);
});

test("assemble: re-claims stale 'sending' rows and stores resend_id", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });
  // Simulate a crashed earlier tick: row stuck at 'sending' with an old lease.
  const staleTs = nowSec() - 3600;
  await db.prepare(
    "INSERT INTO email_sends (run_date, user_id, status, sent_at, claimed_at, resend_id) VALUES (?, ?, 'sending', ?, ?, NULL)"
  ).bind("2026-10-12", "u1", staleTs, staleTs).run();

  const sender = { send: async (m) => ({ ok: true, id: "re_stale1" }) };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r.sent, 1); // retried, not skipped
  const row = await db.prepare(
    "SELECT status, resend_id FROM email_sends WHERE run_date = ? AND user_id = ?"
  ).bind("2026-10-12", "u1").first();
  assert.equal(row.status, "sent");
  assert.equal(row.resend_id, "re_stale1");
});

test("assemble: retries 'failed' rows on the next tick", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });
  // Previous tick marked the row failed (transient Resend error).
  const oldTs = nowSec() - 3600;
  await db.prepare(
    "INSERT INTO email_sends (run_date, user_id, status, sent_at, claimed_at, resend_id) VALUES (?, ?, 'failed', ?, ?, NULL)"
  ).bind("2026-10-12", "u1", oldTs, oldTs).run();

  const sender = { send: async (m) => ({ ok: true, id: "re_retry1" }) };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r.sent, 1);
  const row = await db.prepare(
    "SELECT status, resend_id FROM email_sends WHERE run_date = ? AND user_id = ?"
  ).bind("2026-10-12", "u1").first();
  assert.equal(row.status, "sent");
  assert.equal(row.resend_id, "re_retry1");
});

test("assemble: does not steal rows claimed by an in-flight tick", async () => {
  const db = await freshDB();
  await seedUser(db, { id: "u1", email: "pat@x.com", name: "Pat" });
  await runMarket({ db, market: new MockMarketProvider(MOCK_MARKET), runDate: "2026-10-12", nowSec });
  // Another tick claimed this row 5 minutes ago and is presumably still
  // sending — its lease is fresh, so this run must leave it alone.
  const freshTs = nowSec() - 300;
  await db.prepare(
    "INSERT INTO email_sends (run_date, user_id, status, sent_at, claimed_at, resend_id) VALUES (?, ?, 'sending', ?, ?, NULL)"
  ).bind("2026-10-12", "u1", freshTs, freshTs).run();

  let sends = 0;
  const sender = { send: async (m) => (sends++, { ok: true, id: "re_x" }) };
  const templateText = await readFile(path.join(root, "email", "template.html"), "utf8");
  const r = await runAssemble({
    db, sender, runDate: "2026-10-12", dateLong: "Monday, October 12, 2026",
    origin: "https://example.com", productName: "Morning Brief",
    sessionSecret: "test-secret", templateText, nowSec,
  });
  assert.equal(r.sent, 0);
  assert.equal(sends, 0); // no double-send
  const row = await db.prepare(
    "SELECT status, sent_at FROM email_sends WHERE run_date = ? AND user_id = ?"
  ).bind("2026-10-12", "u1").first();
  assert.equal(row.status, "sending");
  assert.equal(row.sent_at, freshTs); // untouched
});
