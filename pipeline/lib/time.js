// Morning Briefing pipeline — ET time helpers.
// All scheduling is anchored to America/New_York so cron windows stay correct
// across DST. Cloudflare cron triggers are UTC; the worker checks the ET hour.

const ET = "America/New_York";

function etParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });
  return Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
}

/** "2026-10-12" — the ET calendar date. The pipeline's run_date. */
export function runDateET(d = new Date()) {
  const p = etParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 0-23 ET hour. */
export function etHour(d = new Date()) {
  const p = etParts(d);
  return parseInt(p.hour, 10) % 24; // hour12:false yields "24" at midnight
}

/** "Monday, October 12, 2026" in ET. */
export function dateLongET(d = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

/** "2026-10-11" for an ET date — used for news API from/to windows. */
export function addDaysET(runDate, n) {
  const [y, m, day] = runDate.split("-").map(Number);
  // Noon ET avoids any DST edge; construct via UTC offset math on the date.
  const d = new Date(Date.UTC(y, m - 1, day + n, 16, 0, 0));
  return runDateET(d);
}
