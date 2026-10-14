# Morning Brief — email sending setup (do later)

The MVP backend **never sends real email**. `POST /api/auth/request-link` works
in log-only mode: it creates the user + single-use token and writes the magic
link to the server logs (`[request-link] magic link for <email>: <link>`). No
mail leaves the system unless you complete the steps below.

## Current behavior (no setup)

- `RESEND_API_KEY` unset → link is `console.log`'d server-side only.
- Response is always `200 {ok:true}` (uniform; reveals nothing about accounts).
- Set `MAGIC_LINK_DEBUG=true` as a **preview/dev var only** to also get the link
  back as `debug_link` in the JSON response for manual testing. Never enable in
  production.

## Enabling real magic-link email (Resend)

1. **Create a Resend account** at https://resend.com and get an API key
   (Dashboard → API Keys). The free tier covers MVP volumes.
2. **Verify your sending domain** in Resend (Domains → Add Domain, add the DNS
   records). You cannot send from an unverified domain; `onboarding@resend.dev`
   only works for the single account-owner address.
3. **Set the secret** (never commit it):
   `wrangler pages secret put RESEND_API_KEY`
4. **Set the from-address var** in `wrangler.toml`:
   `BRIEFING_FROM = "Morning Brief <briefing@your-verified-domain.com>"`
   (must use the verified domain), then redeploy.
5. **Test**: `POST /api/auth/request-link` with a real address and confirm the
   email arrives; click through to `/api/auth/verify?token=…` → lands on
   `/profile` with the `mb_session` cookie set.

## Notes

- The Resend call in `functions/api/auth/request-link.js` is a single
  `POST https://api.resend.com/emails` with `from` / `to` / `subject` /
  `html` + `text` bodies. Failures are logged server-side; the API still
  returns `200 {ok:true}` so signup UX never breaks on a mail-provider blip.
- Daily newsletter sending (the ~7 AM ET brief) is **out of scope** for this
  MVP — this setup covers only the auth magic links. The newsletter pipeline
  will reuse the same Resend key when it is built.
