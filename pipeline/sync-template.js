// Regenerates pipeline/email-template.js from email/template.html.
// Run: node pipeline/sync-template.js
// (Keeps the worker's bundled template in sync with the design source.)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = await readFile(path.join(root, "email", "template.html"), "utf8");
const stub = await readFile(path.join(root, "pipeline", "email-template.stub.js"), "utf8");

if (!stub.includes("__TEMPLATE_PLACEHOLDER__")) {
  throw new Error("email-template.js stub lost its __TEMPLATE_PLACEHOLDER__ marker");
}
const out = stub.replace("__TEMPLATE_PLACEHOLDER__", () => src.replace(/`/g, "\\`").replace(/\$/g, "\\$"));
await writeFile(path.join(root, "pipeline", "email-template.js"), out, "utf8");
console.log("pipeline/email-template.js synced from email/template.html");
