// GET /api/auth/verify?token=...
// Validates the magic token (exists, not expired, not used), marks it used,
// sets the signed `mb_session` cookie, and 302-redirects to /profile.
// Invalid/expired/used tokens redirect to /?error=bad_link.

import { json, nowSec, signSession, sessionSetCookie } from "../_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  // NOTE: built with `new Response` rather than `Response.redirect()` so the
  // headers stay mutable for the Set-Cookie below (redirect() responses have
  // immutable headers in some runtimes).
  const badLink = () =>
    new Response(null, {
      status: 302,
      headers: { Location: new URL("/?error=bad_link", url).toString() },
    });

  const token = url.searchParams.get("token");
  if (!token) return badLink();

  const row = await env.DB.prepare(
    "SELECT token, user_id, expires_at, used_at FROM magic_tokens WHERE token = ?"
  )
    .bind(token)
    .first();

  if (!row || row.used_at !== null || row.expires_at <= nowSec()) return badLink();

  // Mark used atomically — the AND clause makes a concurrent double-verify lose.
  const upd = await env.DB.prepare(
    "UPDATE magic_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL"
  )
    .bind(nowSec(), token)
    .run();
  if (!upd.meta.changes) return badLink();

  const secret = env.SESSION_SECRET;
  if (!secret) {
    // Must be set as a secret: `wrangler pages secret put SESSION_SECRET`
    return json({ error: "server_misconfigured" }, 500);
  }

  const cookieValue = await signSession(row.user_id, secret);
  const res = new Response(null, {
    status: 302,
    headers: { Location: new URL("/profile", url).toString() },
  });
  res.headers.set("Set-Cookie", sessionSetCookie(cookieValue));
  return res;
}
