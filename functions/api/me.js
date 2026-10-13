// /api/me — session profile.
//   GET   -> 200 {email, first_name, plan, theme} | 401 {error:"unauthorized"}
//   PATCH {first_name?, theme?} -> 200 {ok:true, first_name, theme}
//     (first_name trimmed, 1-50 chars; theme must be "light"|"dark")

import {
  json,
  badRequest,
  requireSession,
  readJson,
  normalizeName,
  isValidName,
  normalizeTheme,
} from "./_lib.js";

export async function onRequestGet(context) {
  const { user, response } = await requireSession(context.request, context.env);
  if (!user) return response;
  return json({
    email: user.email,
    first_name: user.first_name,
    plan: user.plan,
    theme: user.theme === "dark" ? "dark" : "light",
  });
}

export async function onRequestPatch(context) {
  const { request, env } = context;
  const { user, response } = await requireSession(request, env);
  if (!user) return response;

  const body = await readJson(request);
  if (!body) return badRequest("invalid_request");

  let firstName = null;
  if (body.first_name !== undefined) {
    firstName = normalizeName(body.first_name);
    if (!isValidName(firstName)) return badRequest("invalid_first_name");
  }

  let theme = null;
  if (body.theme !== undefined) {
    theme = normalizeTheme(body.theme);
    if (!theme) return badRequest("invalid_theme");
  }

  if (firstName === null && theme === null) return badRequest("invalid_request");

  if (firstName !== null) {
    await env.DB.prepare("UPDATE users SET first_name = ? WHERE id = ?")
      .bind(firstName, user.id)
      .run();
    user.first_name = firstName;
  }
  if (theme !== null) {
    await env.DB.prepare("UPDATE users SET theme = ? WHERE id = ?")
      .bind(theme, user.id)
      .run();
    user.theme = theme;
  }

  return json({
    ok: true,
    first_name: user.first_name,
    theme: user.theme === "dark" ? "dark" : "light",
  });
}
