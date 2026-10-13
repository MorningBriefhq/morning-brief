// /api/admin/signups.csv — Morning Brief signup log as a downloadable CSV (protected).
//   GET ?key=ADMIN_KEY -> 200 text/csv, one row per user:
//     email, first_name, signed_up_utc, tickers, ticker_count, theme, unsubscribed
//   Wrong/missing key -> 403.
//
// DRAFT (stage-1 preparation, 2026-10-12): not yet deployed. Deploy with the
// normal Pages deploy; no new secrets needed — uses the existing ADMIN_KEY.

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return '"' + s.replace(/"/g, '""') + '"';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const rows = await env.DB.prepare(
    `SELECT u.email AS email,
            u.first_name AS first_name,
            u.created_at AS created_at,
            u.theme AS theme,
            u.unsubscribed_at AS unsubscribed_at,
            GROUP_CONCAT(t.ticker, ';') AS tickers
     FROM users u
     LEFT JOIN user_tickers t ON t.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC`
  ).all();

  const header = [
    "email",
    "first_name",
    "signed_up_utc",
    "tickers",
    "ticker_count",
    "theme",
    "unsubscribed",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows.results || []) {
    const tickers = r.tickers || "";
    const count = tickers ? tickers.split(";").length : 0;
    lines.push(
      [
        csvCell(r.email),
        csvCell(r.first_name),
        csvCell(new Date(r.created_at * 1000).toISOString()),
        csvCell(tickers),
        csvCell(count),
        csvCell(r.theme),
        csvCell(r.unsubscribed_at ? "yes" : "no"),
      ].join(",")
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\r\n") + "\r\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="morning-brief-signups-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
