# Morning Brief — MVP Architecture Contract

Product: "Morning Brief" — personalized portfolio-news newsletter. Users sign up
(email + first name, magic-link auth), save S&P 500 tickers to a profile, and get a
daily ~7 AM ET personalized HTML email. Freemium: 10 tickers free.

## Repo layout (Cloudflare Pages + Pages Functions + D1)

```
~/workspace/morning-briefing/
  index.html                 # Landing page: product explainer + signup (email + first name)
  profile.html               # Profile page (requires session): edit name, ticker picker, ticker list
  assets/css/main.css        # Shared site styles
  assets/js/app.js           # Shared frontend JS (auth helpers, API client)
  functions/api/
    auth/request-link.js     # POST {email, first_name} -> create/find user, create token, send/stub link
    auth/verify.js           # GET ?token= -> validate, set session cookie, redirect /profile
    auth/logout.js           # POST -> clear session cookie
    me.js                    # GET -> {email, first_name, plan} | PATCH {first_name}
    tickers.js               # GET list | POST {ticker} add | DELETE via ?ticker= remove
    universe.js              # GET -> S&P 500 [{ticker, name}] (served from data/sp500.json)
  data/sp500.json            # [{ticker, name}] + {as_of} — fetched from public source
  data/refresh-sp500.sh      # Script to refresh the list (document source inside)
  email/template.html        # The HTML email template with {{placeholders}}
  email/sample-email.html    # RENDERED sample (Pat, NVDA/AAPL/JPM, Mon Oct 12 2026) — design approval
  schema.sql                 # D1 schema
  wrangler.toml              # Pages project config (project name: morning-briefing)
  ARCHITECTURE.md            # This file
  pipeline/
    worker.js                # Scheduled worker entry (hourly cron tick, ET windows)
    wrangler.toml            # Worker config: pipeline/wrangler.toml
    stages.js                # ingest / summarize / market / assemble stages
    schema-additions.sql     # pipeline tables + users.unsubscribed_at (apply ONCE)
    lib/                     # time, render, sign, news, summarize, market, send, mock-data
    local-run.js             # local mock-mode harness -> pipeline/outbox/
    test.js                  # node --test pipeline/test.js
    README.md                # pipeline ops doc
  functions/api/unsubscribe.js # GET ?token= -> one-click unsubscribe page
```

## D1 schema (schema.sql)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- crypto.randomUUID()
  email TEXT UNIQUE NOT NULL,      -- lowercase, trimmed
  first_name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  theme TEXT NOT NULL DEFAULT 'light',  -- 'light' | 'dark' (API-validated)
  created_at INTEGER NOT NULL      -- unix seconds
);
CREATE TABLE magic_tokens (
  token TEXT PRIMARY KEY,         -- 32+ random bytes, hex
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,    -- unix seconds, 15 min TTL
  used_at INTEGER                  -- set on verify (single use)
);
CREATE TABLE user_tickers (
  user_id TEXT NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,           -- uppercase, validated against data/sp500.json
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ticker)
);
```

## API contract (JSON, session via signed HttpOnly cookie `mb_session`)

- `POST /api/auth/request-link` body `{email, first_name}` ->
  `200 {ok:true}`. Creates user if new (first_name required then), updates first_name
  if provided for existing. Token TTL 15 min, single-use. Email send is STUBBED:
  if env `RESEND_API_KEY` is set, call Resend to send the link; otherwise log the
  link server-side and (only when env `MAGIC_LINK_DEBUG=true`) include it in the
  response as `debug_link`. NEVER send real mail in this build.
- `GET /api/auth/verify?token=...` -> validate (exists, not expired, not used),
  mark used, set `mb_session` cookie (HMAC-SHA256 of user_id with `SESSION_SECRET`,
  30-day expiry, HttpOnly, Secure, SameSite=Lax, Path=/), redirect 302 to /profile.
  Invalid -> redirect to /?error=bad_link.
- `POST /api/auth/logout` -> clear cookie, `200 {ok:true}`.
- `GET /api/me` -> `200 {email, first_name, plan, theme}` or `401 {error:"unauthorized"}`.
  (`theme` is `"light"` or `"dark"`, defaulting to `"light"` for old rows.)
- `PATCH /api/me` body `{first_name?, theme?}` -> `200 {ok:true, first_name, theme}`.
  At least one field required. `first_name` trimmed, 1-50 chars; `theme` must be
  `"light"` or `"dark"` (`400 {error:"invalid_theme"}` otherwise).
- `GET /api/tickers` -> `200 {tickers:["NVDA","AAPL"]}` (sorted).
- `POST /api/tickers` body `{ticker}` -> validate uppercase, exists in universe;
  free plan max 10 (`403 {error:"ticker_limit"}` beyond). `200 {ok:true, tickers:[...]}`.
  Duplicate -> `200` idempotent.
- `DELETE /api/tickers?ticker=NVDA` -> `200 {ok:true, tickers:[...]}`.
- `GET /api/universe` -> `200 {as_of:"2026-10-11", count:503, stocks:[{ticker,name}]}`.
  Cache client-side; the file is bundled, not in D1.

All 401s return JSON `{error:"unauthorized"}` (frontend redirects to / on 401).

## Session signing

`mb_session = base64url(user_id) + "." + base64url(HMAC_SHA256(user_id, SESSION_SECRET))`.
Verify signature on every authed request. `SESSION_SECRET` from env (wrangler secret
in production; document it).

## Design tokens (shared by site + email)

- Palette (financial-publication, restrained): ink `#101418`, navy `#0e2a47`,
  gold accent `#b8892e` (use sparingly), paper `#ffffff`, soft `#f4f6f8`,
  muted text `#5b6570`, hairline `#e2e7ec`.
- Typography: headlines Georgia/serif for the wordmark gravitas; body/UI
  `-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Email: max-width 640px, fluid tables, ALL CSS inline, tested mentally at 320px.
  No external images required for core layout (text wordmark). Dark-mode-friendly
  where cheap (avoid pure-white backgrounds? keep #ffffff with dark text; fine).

## Theme preference (dark / light) — 2026-10-12

Each user has a `theme` setting: `"light"` or `"dark"`, default `"light"`
(`users.theme`, API-validated; `GET /api/me` returns it, `PATCH /api/me`
accepts it).

**Website** (`index.html`, `profile.html`, `assets/css/main.css`, `assets/js/app.js`):
- The palette lives in CSS variables (`--ink`, `--navy`, `--gold`, `--paper`,
  `--soft`, `--muted`, `--hairline`); a visible toggle in the topbar flips the
  `data-theme` attribute on `<html>`, and `[data-theme="dark"]` swaps the whole
  variable set. A tiny inline script in `<head>` sets the attribute before first
  paint (no light/dark flash).
- Persistence: `localStorage` (`mb_theme`) always; the profile via
  `PATCH /api/me` when the call succeeds (the toggle's save uses a raw fetch so
  a logged-out 401 never triggers the `MB.api` redirect). `prefers-color-scheme`
  is only the initial default when no saved choice exists (localStorage first,
  then the server profile on `/profile`, then the OS preference).
- Dark site palette: `--ink #e8edf4`, `--navy #9fc0e8`, `--gold #c99a3f`,
  `--paper #0d1b2e`, `--soft #152a44`, `--muted #93a1b3`, `--hairline #2b425f`.
  The hero and footer keep dark-navy surfaces in both themes (their inner text
  colors are tuned for it); no pure black anywhere.

**Newsletter email**: rendered in the user's theme. The template is authored in
the light palette; `pipeline/lib/render.js` (`applyEmailTheme`, called from
`renderTemplate(template, data, {theme})`) swaps every light token for its dark
counterpart SERVER-SIDE at render time, so the sent HTML carries inlined dark
colors directly — never `prefers-color-scheme` media queries (email-client
support is spotty). Same layout and structure, dark palette only:
  `#f4f6f8→#0c1929` page bg, `#ffffff→#152a44` card, `#101418→#e8edf4` text,
  `#3a424b→#c2cbd7`, `#5b6570→#93a1b3`, `#e2e7ec→#2b425f` hairlines,
  `#0e2a47→#9fc0e8` navy accents, `#b8892e→#c99a3f` gold. No pure-black
  backgrounds. The assemble stage reads `users.theme` per recipient and passes
  it to the renderer. `email/sample-email-dark.html` is the dark render of the
  same sample data as `email/sample-email.html`, for design approval.

## Email template placeholders (email/template.html)

`{{first_name}}`, `{{date_long}}` (e.g. "Monday, October 12, 2026"),
`{{top_news}}` (list of {headline, summary}),
`{{before_bell}}` (list of {label, text}: Futures, Oil, Gold, Dollar, Europe, Asia),
`{{your_stocks}}` (list of {ticker, company, summary}),
`{{calendar_earnings}}` (list of {ticker, company, time:"Before open"/"After close"}),
`{{calendar_econ}}` (list of {time_et, event}),
plus static disclaimer footer. Sample data lives ONLY in email/sample-email.html.

## Out of scope (do NOT build)

~~Overnight news pipeline,~~ real sending, payments/Stripe, social posts, analytics.
(The overnight pipeline is now built — see below. Sending stays stubbed until
RESEND_API_KEY is set.)

## Overnight pipeline (built 2026-10-11)

Separate scheduled worker (`pipeline/`, project `morning-briefing-pipeline`)
bound to the SAME D1 database. Pages Functions can't run cron triggers, hence
the split; the web app is untouched.

### Schedule

Cloudflare cron `0 * * * *` (hourly tick). The worker checks the
America/New_York hour itself — DST-safe, since cron is UTC and DST-naive:

| ET window | Stages |
|---|---|
| 4:xx AM | **ingest** (overnight news per ticker) → **summarize** (2–3 sentences per ticker with news) → **market** (Top News, Before the Bell, Calendar) |
| 6:xx AM | **assemble** (per-user render) → **send** (emails land ~7 AM ET) |

Stages claim `(run_date, stage)` in `pipeline_runs`; re-runs and overlapping
ticks are safe no-ops. See `pipeline/README.md` for env vars and ops.

### Data flow

1. **Targets**: distinct tickers held by subscribed users (`INGEST_MODE=held`,
   default). `INGEST_MODE=full` walks the whole S&P 500 in chunks via
   `pipeline_progress` (needs paid plan + tighter cron for 503 tickers —
   40/tick at 60 Finnhub calls/min ≈ 13 ticks).
2. **News**: Finnhub `company-news` per ticker over the overnight window
   (`FINNHUB_API_KEY`), else `MockNewsProvider`. Raw articles stored in
   `ticker_news_raw`. Tickers with no news are skipped silently.
3. **Summaries**: one per `(run_date, ticker)`, shared across all users holding
   it (`ticker_summaries`). `AnthropicSummarizer` (`ANTHROPIC_API_KEY`, model via
   `SUMMARIZER_MODEL`) or `MockSummarizer` (deterministic extractive).
4. **Market**: `market_briefs` rows (`top_news`, `before_bell`, `calendar`).
   Mock provider in this build. The user's own agent-produced morning newsletter
   is a candidate real feed for these sections later.
5. **Assemble**: per subscribed user — saved tickers → that day's summaries →
   render `email/template.html` (first name, date, sections, disclaimer,
   per-user signed unsubscribe link) → send. Idempotent via `email_sends`.
6. **Send**: `ResendSender` — real sends only when `RESEND_API_KEY` is set,
   otherwise log-only stub (same pattern as magic-link emails).

### Unsubscribe

`GET /api/unsubscribe?token=…` (Pages Function) verifies the HMAC token
(same format/secret as session cookies), sets `users.unsubscribed_at`.
Pipeline excludes unsubscribed users from sends and ingest targeting.
`users.unsubscribed_at` added by `pipeline/schema-additions.sql` (apply once).

### Cost estimate (~1,000 users)

Finnhub free $0 · summaries ~$5–14/mo · Resend $20/mo plan · D1/Workers/Pages
free tiers → **~$25–35/mo**. ≤100 users: ~$5–14/mo (Resend free tier).

### Name note (2026-10-12)

"Morning Brief" is CONFIRMED as the product name. Domain `morningbrief.link`
purchased 2026-10-12. Rename pass done: Pages project and D1 database are
`morning-briefing`, the pipeline worker is `morning-briefing-pipeline`,
`BRIEFING_FROM` is `Morning Brief <briefing@morningbrief.link>`, and
`PUBLIC_ORIGIN` is `https://morningbrief.link`. `PRODUCT_NAME` (env,
default "Morning Brief") remains the override mechanism for user-visible
strings.

## Decisions log

- Pages + Pages Functions + D1 (single deploy) instead of separate Worker — same
  runtime, simpler. Compatible with the "Worker + D1" requirement.
- Magic-link only auth (no passwords, no OAuth) per spec.
- S&P 500 universe as a bundled JSON refreshed by script, not D1 — read-heavy,
  changes infrequently.
- Ticker validation is case-insensitive input, stored uppercase.
