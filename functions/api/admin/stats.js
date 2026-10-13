// /api/admin/stats — Morning Brief growth metrics (protected).
//   GET ?key=ADMIN_KEY -> 200 {
//     total_users, signups_by_day: [{day, n}], total_tickers,
//     avg_tickers_per_user, users_with_no_tickers, generated_at
//   }
// Wrong/missing key -> 403.

import { json } from "../_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return json({ error: "forbidden" }, 403);
  }

  const totalUsers = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users"
  ).first();
  const byDay = await env.DB.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS n
     FROM users
     WHERE created_at >= strftime('%s', 'now', '-30 days')
     GROUP BY day ORDER BY day ASC`
  ).all();
  const totalTickers = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM user_tickers"
  ).first();
  const avgTickers = await env.DB.prepare(
    `SELECT AVG(c) AS a FROM
     (SELECT COUNT(*) AS c FROM user_tickers GROUP BY user_id)`
  ).first();
  const noTickers = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_tickers t WHERE t.user_id = u.id)`
  ).first();

  return json({
    total_users: totalUsers.n,
    signups_by_day: byDay.results,
    total_tickers: totalTickers.n,
    avg_tickers_per_user: Math.round((avgTickers.a || 0) * 100) / 100,
    users_with_no_tickers: noTickers.n,
    generated_at: new Date().toISOString(),
  });
}
