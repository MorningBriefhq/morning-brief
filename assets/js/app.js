/* Morning Brief — shared frontend helpers (vanilla JS, no frameworks).
 * Provides: MB.api (JSON fetch with 401 -> "/" redirect), MB.toast,
 * MB.escapeHtml, and the MB.theme helpers (dark/light toggle). */
(function () {
  "use strict";

  var THEME_KEY = "mb_theme";

  /** Saved theme choice ("light"|"dark") or null when the user never chose. */
  function savedTheme() {
    try {
      var t = window.localStorage.getItem(THEME_KEY);
      return t === "light" || t === "dark" ? t : null;
    } catch (e) {
      return null;
    }
  }

  /** Effective theme: saved choice, else the OS preference, else light. */
  function effectiveTheme() {
    var saved = savedTheme();
    if (saved) return saved;
    try {
      if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        return "dark";
      }
    } catch (e) {
      // fall through to light
    }
    return "light";
  }

  /** Apply a theme to the document (flips the CSS variable set). */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  /**
   * Persist a theme choice: localStorage always, plus the user profile via
   * PATCH /api/me when that succeeds (raw fetch — a 401 just means the
   * visitor is logged out, and must NOT trigger the MB.api redirect).
   */
  function persistTheme(theme) {
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // storage unavailable; the attribute still applies for this visit
    }
    try {
      fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: theme }),
      }).catch(function () {
        // logged out or offline — localStorage already holds the choice
      });
    } catch (e) {
      // ignore
    }
  }

  /** Set the theme now: apply + persist. */
  function setTheme(theme) {
    if (theme !== "light" && theme !== "dark") return;
    applyTheme(theme);
    persistTheme(theme);
  }

  /**
   * Wire a toggle button: label reflects the current theme, click flips it.
   * Button content: a sun/moon glyph plus the theme name.
   */
  function initThemeToggle(button) {
    if (!button) return;
    // Icon only: moon in light mode (tap for dark), sun in dark mode (tap for light).
    var MOON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    var SUN_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
    function paintGlyphs() {
      var t = document.documentElement.getAttribute("data-theme") || "light";
      button.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
      button.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
      button.innerHTML = t === "dark" ? SUN_SVG : MOON_SVG;
    }
    paintGlyphs();
    button.addEventListener("click", function () {
      var t = document.documentElement.getAttribute("data-theme") || "light";
      setTheme(t === "dark" ? "light" : "dark");
      paintGlyphs();
    });
    // Re-paint if something else (e.g. the profile load) changes the theme.
    var observer = new MutationObserver(function () {
      paintGlyphs();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }

  /** Escape a string for safe insertion into HTML. */
  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  /**
   * JSON API wrapper. Resolves with the parsed body on 2xx.
   * On 401: redirects to "/" and resolves null (page navigates away).
   * On other non-2xx: throws Error with .status and .body attached.
   */
  async function api(path, options) {
    const opts = Object.assign(
      { headers: { "Content-Type": "application/json" } },
      options || {}
    );
    const res = await fetch(path, opts);
    if (res.status === 401) {
      window.location.replace("/");
      return null;
    }
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      // Non-JSON body; keep data as {}.
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || "Request failed");
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  /**
   * Show a transient toast message. type: "info" (default) | "error" | "success".
   */
  function toast(message, type) {
    type = type || "info";
    let host = document.getElementById("toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-host";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.textContent = message;
    host.appendChild(el);
    // Animate in on next frame so the CSS transition runs.
    requestAnimationFrame(function () {
      el.classList.add("toast-show");
    });
    setTimeout(function () {
      el.classList.remove("toast-show");
      setTimeout(function () {
        el.remove();
      }, 300);
    }, 4200);
  }

  window.MB = {
    api: api,
    toast: toast,
    escapeHtml: escapeHtml,
    theme: {
      saved: savedTheme,
      effective: effectiveTheme,
      apply: applyTheme,
      set: setTheme,
      initToggle: initThemeToggle,
    },
  };
})();

// Market snapshot strip (homepage)
(function () {
  var strip = document.getElementById("market-strip");
  var container = document.getElementById("market-items");
  if (!strip || !container) return;
  fetch("/api/market-snapshot")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.items || !d.items.length) return;
      container.innerHTML = "";
      d.items.forEach(function (it) {
        var div = document.createElement("div");
        div.className = "market-item";
        var sign = it.change_pct >= 0 ? "+" : "";
        div.innerHTML =
          '<span class="m-label">' + it.label + "</span>" +
          '<span class="m-chg ' + (it.up ? "up" : "down") + '">' +
          sign + it.change_pct.toFixed(2) + "%</span>";
        container.appendChild(div);
      });
      strip.style.display = "";
    })
    .catch(function () {});
})();

// Show/hide the Profile nav link based on session (raw fetch — no redirect on 401)
// Cached in sessionStorage so we don't hit /api/me on every page load.
(function () {
  var links = document.querySelectorAll('a[href="/profile.html"].nav-cta');
  if (!links.length) return;
  function show(showIt) {
    links.forEach(function (l) { l.style.display = showIt ? "" : "none"; });
  }
  var cached = null;
  try { cached = sessionStorage.getItem("mb_signed_in"); } catch (e) {}
  if (cached === "1") { show(true); return; }
  if (cached === "0") { show(false); return; }
  show(false);
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (res) {
      if (!res.ok) {
        try { sessionStorage.setItem("mb_signed_in", "0"); } catch (e) {}
        return null;
      }
      return res.json();
    })
    .then(function (me) {
      var signedIn = !!(me && me.email);
      try { sessionStorage.setItem("mb_signed_in", signedIn ? "1" : "0"); } catch (e) {}
      show(signedIn);
    })
    .catch(function () {});
})();

// Hamburger menu (mobile slide-in drawer)
(function () {
  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("topbar-nav");
  var scrim = document.getElementById("nav-scrim");
  if (!toggle || !nav) return;
  function setOpen(open) {
    nav.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (scrim) scrim.classList.toggle("show", open);
    document.body.style.overflow = open ? "hidden" : "";
  }
  toggle.addEventListener("click", function () {
    setOpen(!nav.classList.contains("open"));
  });
  if (scrim) scrim.addEventListener("click", function () { setOpen(false); });
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A") setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && nav.classList.contains("open")) setOpen(false);
  });
})();
