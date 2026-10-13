// Morning Briefing pipeline — minimal HTML email renderer.
//
// Implements the placeholder contract documented at the top of
// email/template.html:
//   Scalars: {{first_name}} {{date_long}} {{preheader}} {{unsubscribe_url}}
//   Loops:   {{#each top_news}} ... {{/each}}      -> {headline, summary, index}
//            {{#each before_bell}} ... {{/each}}   -> {label, text}
//            {{#each your_stocks}} ... {{/each}}   -> {ticker, company, summary}
//            {{#each calendar_earnings}} ... {{/each}} -> {ticker, company, time}
//            {{#each calendar_econ}} ... {{/each}} -> {time_et, event}
// Empty lists remove the whole block. All values are HTML-escaped.
// Unknown placeholders render as empty strings (never leak template syntax).

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EACH_RE = /\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
const IF_RE = /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VAR_RE = /\{\{(\w+)\}\}/g;

// Dark email palette — applied SERVER-SIDE at render time per user's theme.
// The template itself is authored in the light palette; when theme is "dark"
// every light token below is swapped for its dark counterpart, so the final
// HTML carries inlined dark colors directly. Never rely on email-client
// prefers-color-scheme media queries (support is spotty). Same layout and
// structure — dark palette only. Restrained financial-publication feel:
// ink-navy surfaces, soft-paper text, gold accent sparingly. No pure black.
const DARK_EMAIL_TOKENS = {
  "#f4f6f8": "#0c1929", // page background      -> deep navy
  "#ffffff": "#152a44", // card surface         -> navy surface
  "#101418": "#e8edf4", // primary text (ink)   -> soft paper
  "#3a424b": "#c2cbd7", // secondary text       -> light slate
  "#5b6570": "#93a1b3", // muted text           -> muted slate
  "#e2e7ec": "#2b425f", // hairlines            -> dark slate line
  "#0e2a47": "#9fc0e8", // navy accents         -> light steel blue
  "#b8892e": "#c99a3f", // gold accent          -> lifted gold (dark-bg legibility)
};
const DARK_TOKEN_RE = new RegExp(Object.keys(DARK_EMAIL_TOKENS).join("|"), "gi");

export function applyEmailTheme(html, theme) {
  if (theme === "dark") {
    return html.replace(DARK_TOKEN_RE, (m) => DARK_EMAIL_TOKENS[m.toLowerCase()]);
  }
  return html;
}

export function renderTemplate(template, data, options = {}) {
  // HTML comments are documentation only (the template's own placeholder
  // reference lives in one) — strip them so {{#each}} examples in comments
  // can never be mistaken for real template blocks.
  const clean = template.replace(/<!--[\s\S]*?-->/g, "");
  // Loops first (so {{index}} and item keys resolve per item).
  let out = clean.replace(EACH_RE, (_m, name, block) => {
    const items = data[name];
    if (!Array.isArray(items) || items.length === 0) return "";
    return items
      .map((item, i) =>
        block.replace(VAR_RE, (_mm, key) => {
          if (key === "index") return String(i + 1);
          const v = item[key];
          return v == null ? "" : escapeHtml(String(v));
        })
      )
      .join("");
  });
  // Conditionals: {{#if name}}...{{/if}} renders block if data[name] is truthy.
  // Supports dotted paths like {{#if picture}} with {{picture.image}} inside.
  out = out.replace(IF_RE, (_m, name, block) => {
    const val = name.split(".").reduce((o, k) => (o == null ? o : o[k]), data);
    if (!val) return "";
    return block.replace(/\{\{([\w.]+)\}\}/g, (_mm, key) => {
      const v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), data);
      return v == null ? "" : escapeHtml(String(v));
    });
  });
  // Scalars.
  out = out.replace(VAR_RE, (_m, key) => {
    const v = data[key];
    return v == null ? "" : escapeHtml(String(v));
  });
  // Theme is a render option, not a placeholder: "dark" inlines the dark
  // palette server-side; anything else renders the authored light palette.
  return applyEmailTheme(out, options.theme);
}
