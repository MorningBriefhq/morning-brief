// Morning Brief pipeline — email senders.
//
// Interface: send({to, subject, html, text, headers}) -> {ok, id?|file?|stubbed?}
//   headers is optional; used for List-Unsubscribe / List-Unsubscribe-Post.
// ResendSender also offers sendBatch(messages) -> [{ok, to, id?}] in input
// order, via Resend's /emails/batch (up to 100 per call, per-recipient
// headers preserved). Batch is all-or-nothing: sendBatch THROWS on failure
// so the caller can fall back to serial sends.
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
  _checkKey(to, subject) {
    if (!this.apiKey) {
      // Never silently stub in production: a missing key is a hard failure.
      // (2026-10-15: the old stub returned ok:true, which stages.js recorded
      // as 'sent' — two days of zero emails with no error anywhere.)
      throw new Error(
        `RESEND_API_KEY unset — cannot send to ${to} subject="${subject}"`
      );
    }
  }
  _payload({ to, subject, html, text, headers }) {
    return {
      from: this.from,
      to: [to],
      subject,
      html,
      text: text || undefined,
      headers: headers && Object.keys(headers).length ? headers : undefined,
    };
  }
  async send({ to, subject, html, text, headers }) {
    this._checkKey(to, subject);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this._payload({ to, subject, html, text, headers })),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[send] Resend failed for ${to}: ${res.status} ${body.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data.id };
  }

  /** Batch send. messages: [{to, subject, html, text, headers}].
   *  Chunked at 100 per Resend /emails/batch call. Returns one result per
   *  input message, in input order. THROWS on any batch failure (the endpoint
   *  is all-or-nothing) — the caller should fall back to serial sends. */
  async sendBatch(messages) {
    if (!this.apiKey) {
      throw new Error(
        `RESEND_API_KEY unset — cannot batch-send ${messages.length} emails`
      );
    }
    const results = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chunk.map((m) => this._payload(m))),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(
          `[send] Resend batch failed (chunk ${i / 100 + 1}): ${res.status} ${body.slice(0, 200)}`
        );
        throw new Error(`Resend batch send failed: ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      const ids = Array.isArray(data.data) ? data.data : [];
      chunk.forEach((msg, j) =>
        results.push({ ok: true, to: msg.to, id: ids[j] && ids[j].id })
      );
    }
    return results;
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
