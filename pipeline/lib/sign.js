// Morning Briefing pipeline — token signing for unsubscribe links.
//
// Mirrors the exact algorithm in functions/api/_lib.js so tokens minted here
// verify there (and vice versa):
//   token = base64url(user_id) + "." + base64url(HMAC_SHA256(user_id, secret))
// WebCrypto only — works in Cloudflare Workers and Node 18+.

const te = new TextEncoder();
const td = new TextDecoder();

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToBytes(s) {
  let b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

export async function signToken(userId, secret) {
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(userId));
  return `${b64urlEncode(te.encode(userId))}.${b64urlEncode(sig)}`;
}

export async function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let userId;
  try {
    userId = td.decode(b64urlDecodeToBytes(parts[0]));
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
