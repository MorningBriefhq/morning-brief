// POST /api/auth/request-link  {email, first_name}
// Find-or-create user, mint a single-use 15-min magic token, and deliver the
// sign-in link. Always responds 200 {ok:true} on success so the response never
// reveals anything about the account.
//
// Email delivery: if env RESEND_API_KEY is set, the link is sent via Resend.
// Otherwise the link is only logged server-side (log-only mode — no real mail
// is ever sent by this build). If env MAGIC_LINK_DEBUG === "true", the link is
// also returned as `debug_link` (dev/preview only — never enable in production).

import {
  json,
  badRequest,
  nowSec,
  readJson,
  normalizeEmail,
  isValidEmail,
  normalizeName,
  isValidName,
  escapeHtml,
} from "../_lib.js";

// ---- MVP rate limit: max 5 requests per email per 10 minutes ----
// NOTE: in-memory per-isolate Map. It does not share state across Cloudflare
// isolates, so a distributed client can exceed it. Adequate to slow casual
// abuse for the MVP; move to D1/KV or the Rate Limiting API before launch.
const attempts = new Map(); // email -> [unixSec, ...]
const WINDOW_S = 10 * 60;
const MAX_ATTEMPTS = 5;

function isRateLimited(email) {
  const now = nowSec();
  const recent = (attempts.get(email) || []).filter((t) => now - t < WINDOW_S);
  if (recent.length >= MAX_ATTEMPTS) return true;
  recent.push(now);
  attempts.set(email, recent);
  return false;
}

function randomTokenHex(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes)); // 32+ random bytes
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const TOKEN_TTL_S = 15 * 60;

export async function onRequestPost(context) {
  const { request, env } = context;

  const body = await readJson(request);
  if (!body) return badRequest("invalid_request");

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return badRequest("invalid_email");

  const firstName = normalizeName(body.first_name);
  const nameProvided = firstName.length > 0;
  if (nameProvided && !isValidName(firstName)) return badRequest("invalid_first_name");

  if (isRateLimited(email)) return json({ error: "rate_limited" }, 429);

  // find-or-create (first_name required for new users; updated when provided)
  let user = await env.DB.prepare(
    "SELECT id, email, first_name, plan FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (!user) {
    if (!nameProvided) return badRequest("first_name_required");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, first_name, plan, created_at) VALUES (?, ?, ?, 'free', ?)"
    )
      .bind(id, email, firstName, nowSec())
      .run();
    user = { id, email, first_name: firstName, plan: "free" };
  } else if (nameProvided && firstName !== user.first_name) {
    await env.DB.prepare("UPDATE users SET first_name = ? WHERE id = ?")
      .bind(firstName, user.id)
      .run();
    user.first_name = firstName;
  }

  // single-use token
  const token = randomTokenHex(32);
  await env.DB.prepare(
    "INSERT INTO magic_tokens (token, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
  )
    .bind(token, user.id, nowSec() + TOKEN_TTL_S)
    .run();

  const link = `${new URL(request.url).origin}/api/auth/verify?token=${token}`;
  const from = env.BRIEFING_FROM || "Morning Brief <briefing@morningbrief.link>";

  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: "Your Morning Brief sign-in link",
          html:
            `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f3ed;">` +
            `<div style="max-width:480px;margin:0 auto;padding:40px 20px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
            `<div style="text-align:center;margin-bottom:24px;">` +
            `<div style="font-size:28px;color:#d4af37;margin-bottom:8px;">&#9670;</div>` +
            `<div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#0f1a2e;">Morning <span style="color:#d4af37;">Brief</span></div>` +
            `</div>` +
            `<div style="background:#ffffff;border-radius:12px;padding:32px 28px;text-align:center;box-shadow:0 2px 8px rgba(15,26,46,0.08);">` +
            `<p style="font-size:16px;color:#0f1a2e;margin:0 0 8px;">Hi ${escapeHtml(user.first_name)},</p>` +
            `<p style="font-size:15px;color:#5b6570;margin:0 0 24px;line-height:1.6;">Tap the button below to sign in to Morning Brief.</p>` +
            `<a href="${escapeHtml(link)}" style="display:inline-block;background:#0f1a2e;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 40px;border-radius:8px;">Sign in</a>` +
            `<p style="font-size:13px;color:#8a94a0;margin:24px 0 0;line-height:1.6;">This link expires in 15 minutes and can only be used once.<br>If you didn't request this, you can ignore it.</p>` +
            `</div>` +
            `<p style="text-align:center;font-size:12px;color:#a0aec0;margin:24px 0 0;">For informational purposes only. Not investment advice.</p>` +
            `</div></body></html>`,
          text:
            `Hi ${user.first_name},\n\n` +
            `Sign in to Morning Brief:\n${link}\n\n` +
            `This link expires in 15 minutes and can only be used once.`,
        }),
      });
      if (!res.ok) {
        console.error("[request-link] Resend send failed", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.error("[request-link] Resend request error", e);
    }
  } else {
    // Log-only mode: no real mail leaves this build.
    console.log(`[request-link] magic link for ${email}: ${link}`);
  }

  const out = { ok: true };
  if (env.MAGIC_LINK_DEBUG === "true") out.debug_link = link;
  return json(out);
}
