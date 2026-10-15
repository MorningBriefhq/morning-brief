// POST /api/webhooks/resend
//
// Resend deliverability events (Svix-signed). Handled events:
//   email.bounced    -> suppress the recipient (hard bounces kill deliverability)
//   email.complained -> suppress the recipient (spam complaints must stop mail)
// All other event types are acknowledged with no side effects.
//
// Signature verification (Svix scheme, Web Crypto only — no Node builtins):
//   headers: svix-id, svix-timestamp, svix-signature
//   secret:  RESEND_WEBHOOK_SECRET (starts with "whsec_", copied from the
//            Resend dashboard: Webhooks -> endpoint -> signing secret)
//   key = base64decode(secret minus the "whsec_" prefix)
//   expected = base64(HMAC_SHA256(key, `${svix-id}.${svix-timestamp}.${rawBody}`))
//   accept if ANY space-separated "v1,<base64>" entry matches (constant-time);
//   reject timestamps more than 5 minutes old (replay protection).
//
// CRITICAL: verify against the RAW request body (request.text()). Parsing to
// JSON and re-serializing changes bytes and will break the signature check.
//
// Responses: 200 on accepted+verified (Resend retries non-2xx), 400 on
// missing signature headers or malformed payload, 401 on bad signature or
// missing webhook secret (fail closed — never process unverified events).

import { json, nowSec, normalizeEmail } from "../_lib.js";

const te = new TextEncoder();

function b64ToBytes(b64) {
  const bin = atob(String(b64).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifySvixSignature({ id, timestamp, signature, rawBody, secret }) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  let keyBytes;
  try {
    keyBytes = b64ToBytes(secret.replace(/^whsec_/, ""));
  } catch {
    return false;
  }
  if (keyBytes.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, te.encode(`${id}.${timestamp}.${rawBody}`))
  );
  const expected = b64Encode(mac);
  return signature.split(" ").some((entry) => {
    const comma = entry.indexOf(",");
    if (comma === -1) return false;
    const version = entry.slice(0, comma);
    const sig = entry.slice(comma + 1);
    if (version !== "v1" || !sig) return false;
    let given;
    try {
      given = b64ToBytes(sig);
    } catch {
      return false;
    }
    return constantTimeEqual(given, mac);
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const svixId = request.headers.get("svix-id");
  const svixTs = request.headers.get("svix-timestamp");
  const svixSig = request.headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) {
    return json({ error: "missing_signature_headers" }, 400);
  }

  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook/resend] RESEND_WEBHOOK_SECRET not configured — rejecting unverified event");
    return json({ error: "webhook_not_configured" }, 401);
  }

  const rawBody = await request.text();
  let verified = false;
  try {
    verified = await verifySvixSignature({
      id: svixId,
      timestamp: svixTs,
      signature: svixSig,
      rawBody,
      secret,
    });
  } catch (e) {
    console.error("[webhook/resend] signature verification error:", e.message);
  }
  if (!verified) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const type = event && event.type;
  const data = (event && event.data) || {};
  if (type !== "email.bounced" && type !== "email.complained") {
    return json({ received: true, handled: false });
  }

  const to = Array.isArray(data.to) ? data.to[0] : data.to;
  const email = normalizeEmail(to);
  if (!email) {
    console.error(`[webhook/resend] ${type}: no recipient in payload`);
    return json({ received: true, handled: false });
  }
  if (!env.DB) {
    console.error(`[webhook/resend] ${type} for ${email}: DB binding missing — suppression NOT recorded`);
    return json({ error: "db_unavailable" }, 503);
  }

  const reason =
    type === "email.bounced"
      ? `bounce${data.bounce && data.bounce.message ? `: ${String(data.bounce.message).slice(0, 200)}` : ""}`
      : "complaint";
  await env.DB.prepare(
    "INSERT OR REPLACE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)"
  )
    .bind(email, reason, nowSec())
    .run();
  // Belt and suspenders: flag the user row too, so the address stops even if
  // some future send path skips the suppressions check.
  await env.DB.prepare("UPDATE users SET unsubscribed_at = ? WHERE email = ?")
    .bind(nowSec(), email)
    .run();
  console.log(`[webhook/resend] suppressed ${email} (${type})`);
  return json({ received: true, handled: true });
}
