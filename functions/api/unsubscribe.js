// GET /api/unsubscribe?token=...
// One-click unsubscribe. The token uses the same HMAC format as the session
// cookie (see _lib.js verifySessionCookie): base64url(user_id).base64url(sig).
// Verifies, sets users.unsubscribed_at, shows a plain confirmation page.
// Unsubscribed users are skipped by the overnight pipeline (they keep their
// account and tickers; they just stop receiving mail).

import { verifySessionCookie, nowSec } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";

  let userId = null;
  if (env.SESSION_SECRET) {
    userId = await verifySessionCookie(token, env.SESSION_SECRET);
  }

  if (!userId) {
    return new Response(
      "<!doctype html><html><body style=\"font-family:sans-serif;padding:40px\">" +
        "<h1>Link invalid</h1><p>This unsubscribe link is invalid or expired.</p>" +
        "</body></html>",
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  await env.DB.prepare("UPDATE users SET unsubscribed_at = ? WHERE id = ?")
    .bind(nowSec(), userId)
    .run();

  return new Response(
    "<!doctype html><html><body style=\"font-family:sans-serif;padding:40px;max-width:560px;margin:0 auto\">" +
      "<h1>You&rsquo;re unsubscribed</h1>" +
      "<p>You won&rsquo;t receive Morning Briefing anymore. Your account and ticker list are kept " +
      "in case you change your mind.</p>" +
      "</body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
