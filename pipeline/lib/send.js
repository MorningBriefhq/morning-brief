// Morning Brief pipeline — email senders.
//
// Interface: send({to, subject, html, text}) -> {ok, id?|file?|stubbed?}
//
// ResendSender: real sending via Resend. If no API key is set it is strictly
// log-only (mirrors the pattern in functions/api/auth/request-link.js) — no
// real mail ever leaves without RESEND_API_KEY.
// FileOutboxSender: writes rendered HTML to disk for local verification.

export class Sender {
  async send(_msg) {
    throw new Error("Sender.send not implemented");
  }
}

export class ResendSender extends Sender {
  constructor(apiKey, from) {
    super();
    this.apiKey = apiKey;
    this.from = from;
  }
  async send({ to, subject, html, text }) {
    if (!this.apiKey) {
      // Never silently stub in production: a missing key is a hard failure.
      // (2026-10-15: the old stub returned ok:true, which stages.js recorded
      // as 'sent' — two days of zero emails with no error anywhere.)
      throw new Error(
        `RESEND_API_KEY unset — cannot send to ${to} subject="${subject}"`
      );
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject,
        html,
        text: text || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[send] Resend failed for ${to}: ${res.status} ${body.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data.id };
  }
}

export class FileOutboxSender extends Sender {
  constructor(dir, fs) {
    super();
    this.dir = dir;
    this.fs = fs; // node:fs/promises injected (keeps this module runtime-agnostic)
  }
  async send({ to, subject, html }) {
    const slug = String(to).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const file = `${this.dir}/${slug}.html`;
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.fs.writeFile(file, html, "utf8");
    console.log(`[outbox] ${subject} -> ${file}`);
    return { ok: true, file };
  }
}
