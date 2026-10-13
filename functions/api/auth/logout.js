// POST /api/auth/logout — clears the mb_session cookie. 200 {ok:true}.

import { json, sessionClearCookie } from "../_lib.js";

export async function onRequestPost(context) {
  return json({ ok: true }, 200, { "Set-Cookie": sessionClearCookie() });
}
