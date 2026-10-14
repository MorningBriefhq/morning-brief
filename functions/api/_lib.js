// Morning Brief — shared API helpers (Pages Functions).
// Web Crypto API only. No Node builtins.

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- responses ----------
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export function badRequest(error) {
  return json({ error }, 400);
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------- base64url ----------
export function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecodeToBytes(s) {
  let b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlDecodeToString(s) {
  return td.decode(b64urlDecodeToBytes(s));
}

// ---------- session signing ----------
// mb_session = base64url(user_id) + "." + base64url(HMAC_SHA256(user_id, SESSION_SECRET))
async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

export async function signSession(userId, secret) {
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(userId));
  return `${b64urlEncode(te.encode(userId))}.${b64urlEncode(sig)}`;
}

export async function verifySessionCookie(cookieValue, secret) {
  const parts = String(cookieValue || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let userId;
  try {
    userId = b64urlDecodeToString(parts[0]);
  } catch {
    return null;
  }
  if (!userId) return null;
  let sigBytes;
  try {
    sigBytes = b64urlDecodeToBytes(parts[1]);
  } catch {
    return null;
  }
  const key = await hmacKey(secret, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, te.encode(userId));
  return ok ? userId : null;
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, per contract

export function sessionSetCookie(value) {
  return `mb_session=${value}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionClearCookie() {
  return `mb_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

// Returns the D1 user row for a valid session cookie, or null.
export async function getSessionUser(request, env) {
  const secret = env.SESSION_SECRET;
  if (!secret || !env.DB) return null;
  const raw = getCookie(request, "mb_session");
  if (!raw) return null;
  const userId = await verifySessionCookie(raw, secret);
  if (!userId) return null;
  const row = await env.DB.prepare(
    "SELECT id, email, first_name, plan, theme, created_at FROM users WHERE id = ?"
  )
    .bind(userId)
    .first();
  return row || null;
}

// Convenience: { user } on success, { response: 401 } on failure.
export async function requireSession(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return { response: unauthorized() };
  return { user };
}

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

export function isValidEmail(v) {
  return v.length > 0 && v.length <= 254 && EMAIL_RE.test(v);
}

export function normalizeName(v) {
  return String(v || "").trim();
}

export function isValidName(v) {
  return v.length >= 1 && v.length <= 50;
}

export function normalizeTheme(v) {
  const t = String(v || "").trim().toLowerCase();
  return t === "light" || t === "dark" ? t : null;
}

// Only used for the (optional) Resend HTML email body — API responses are JSON.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
