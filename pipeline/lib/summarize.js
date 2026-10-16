// Morning Brief pipeline — AI synthesis & summarization engine.

export function truncateWords(text, maxWords) {
  if (!text) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

/**
 * Cap a story summary to ~80-95 words (~680 chars / up to 5 sentences) for LSEG density.
 * Always terminates on a complete sentence boundary whenever >= 2 sentences fit.
 */
export function capSummary(text, maxChars = 680, maxSentences = 5) {
  if (!text) return text;
  const cleaned = text
    .replace(/\*\*(what happened|why it matters|what's next|what to watch|summary)[:\s]*\*\*/gi, "")
    .replace(/^(what happened|why it matters|what's next|what to watch|summary)\s*:\s*/gim, "")
    .replace(/\s+/g, " ")
    .trim();

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);

  let out = "";
  let count = 0;
  for (const s of sentences) {
    if (count >= maxSentences) break;
    const candidate = out ? `${out}${s}` : s;
    if (candidate.length > maxChars && count >= 2) break;
    out = candidate;
    count++;
  }

  if (!out) out = cleaned;
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastPeriod = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (lastPeriod > maxChars * 0.5) {
      out = cut.slice(0, lastPeriod + 1).trim();
    } else {
      const lastSpace = cut.lastIndexOf(" ");
      out = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + ".";
    }
  }
  return out;
}

export class Summarizer {
  async summarize(_ticker, _company, _articles) {
    throw new Error("Summarizer.summarize not implemented");
  }
  async summarizeStory(_headline, _sources, _marketContext) {
    throw new Error("Summarizer.summarizeStory not implemented");
  }
  async complete(_systemPrompt, _userPrompt, _options) {
    throw new Error("Summarizer.complete not implemented");
  }
}

export class MockSummarizer extends Summarizer {
  async summarize(_ticker, _company, articles) {
    const sentences = [];
    for (const a of articles.slice(0, 3)) {
      const text = (a.summary || a.headline || "").trim();
      if (!text) continue;
      const first = text.split(/(?<=[.!?])\s/)[0].trim();
      if (first && !sentences.includes(first)) sentences.push(first);
      if (sentences.length >= 3) break;
    }
    return sentences.join(" ");
  }

  async summarizeStory(headline, sources) {
    let text = "";
    if (Array.isArray(sources)) {
      text = sources.map((s) => s.text || "").join(" ").trim();
    } else {
      text = (sources || headline || "").trim();
    }
    const base = text.split(/(?<=[.!?])\s/)[0].trim() || headline;
    if (base.length < 300) {
      return (
        base +
        " The announcement reshapes near-term capital allocation and margin expectations across the sector, according to company filings. " +
        "Institutional desks are repricing forward earnings estimates ahead of next week's quarterly disclosures and management guidance updates."
      );
    }
    return base;
  }

  async complete(_systemPrompt, userPrompt) {
    if (userPrompt && userPrompt.includes("JSON array")) {
      return JSON.stringify([
        {
          ticker: "TRV",
          company: "Travelers Companies Inc",
          reason: "Travelers is scheduled to report Q3 earnings before the opening bell with consensus EPS estimated at $3.65, according to company filings.",
        },
      ]);
    }
    return "US equity futures steadied before the bell as Treasury yields eased and investors weighed corporate earnings against upcoming Federal Reserve commentary.";
  }
}

export class WorkersAISummarizer extends Summarizer {
  constructor(aiBinding, model) {
    super();
    this.ai = aiBinding;
    this.model = model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  }

  async complete(systemPrompt, userPrompt, { maxTokens = 800, temperature = 0.15 } = {}) {
    const res = await this.ai.run(this.model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
    });
    const text = (res.response || "").trim();
    if (!text) throw new Error("workers-ai returned no text");
    return text;
  }

  async summarize(ticker, company, articles) {
    const items = articles
      .slice(0, 8)
      .map((a, i) => `[${i + 1}]${a.source}: ${a.headline}\n${a.summary || ""}`)
      .join("\n\n");
    return this.complete(
      "You write Morning Brief summaries for institutional investors. Deliver what happened with specific numbers/names, why it matters, and what is next. Be dense and factual. Never give investment advice.",
      `Summarize the overnight news for ${company} (${ticker}) in 60-80 words.\n\n${items}`,
      { maxTokens: 300, temperature: 0.15 }
    );
  }

  /**
   * Synthesize a single news story cluster from MULTIPLE pooled sources into an 80-90 word
   * LSEG Morning News Call paragraph: WHAT HAPPENED + WHY IT MATTERS + WHAT NEXT.
   */
  async summarizeStory(headline, sources, marketContext = "") {
    const sourceText = Array.isArray(sources)
      ? sources
          .map((s, i) => `[Source ${i + 1} — ${s.source || "Wire"}]:\n${s.text || ""}`)
          .join("\n\n")
      : String(sources || "");

    const systemPrompt =
      "You are the senior markets editor of Morning Brief, writing in the exact institutional style of the LSEG Morning News Call. " +
      "Synthesize the pooled source material into ONE cohesive paragraph of 75 to 95 words (3 to 4 dense sentences). " +
      "Follow this strict 3-part progression without using section labels or bullet points:\n" +
      "1. WHAT HAPPENED (Sentences 1-2): Lead with the concrete action, policy move, or corporate announcement. Include exact numbers, dollar figures, percentages, basis points, and clear attribution ('the company said', 'according to an SEC filing', 'central bank data showed').\n" +
      "2. WHY IT MATTERS (Sentence 3): State the specific financial mechanism linking this event to S&P 500 earnings, sector margins, interest-rate pricing, or supply chains.\n" +
      "3. WHAT NEXT (Sentence 4): Name the concrete upcoming catalyst, effective date, vote, earnings call, or scheduled economic print.\n" +
      "STRICT RULES: Never repeat the headline verbatim. Never use dramatic verbs ('plummeted', 'skyrocketed', 'cratered'). " +
      "Never write empty filler ('investors will closely watch', 'underscores worries', 'fueled skepticism', 'sets the tone'). " +
      "If Live Market Context is provided, ensure any asset price references align with current pre-market levels. Never give investment advice.";

    const userPrompt =
      `Write an 80-90 word LSEG-style synthesis paragraph for this story cluster.\n\n` +
      `Lead Headline: ${headline}\n` +
      (marketContext ? `Live Pre-Market Quotes (ground truth): ${marketContext}\n` : "") +
      `\nPooled Wire & Article Sources:\n${sourceText || "(no additional details)"}`;

    return this.complete(systemPrompt, userPrompt, { maxTokens: 320, temperature: 0.15 });
  }
}

export class AnthropicSummarizer extends Summarizer {
  constructor(apiKey, model) {
    super();
    this.apiKey = apiKey;
    this.model = model || "claude-haiku-4-5";
  }

  async complete(systemPrompt, userPrompt, { maxTokens = 600, temperature = 0.15 } = {}) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}:${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!text) throw new Error("anthropic returned no text");
    return text;
  }

  async summarize(ticker, company, articles) {
    const items = articles
      .slice(0, 8)
      .map((a, i) => `[${i + 1}]${a.source}: ${a.headline}\n${a.summary || ""}`)
      .join("\n\n");
    return this.complete(
      "You write Morning Brief summaries for institutional investors. Neutral tone, facts only.",
      `Summarize the overnight news for ${company} (${ticker}) in 3 tight sentences (what happened, why it matters, what's next).\n\n${items}`,
      { maxTokens: 250 }
    );
  }

  async summarizeStory(headline, sources, marketContext = "") {
    const sourceText = Array.isArray(sources)
      ? sources.map((s, i) => `[Source ${i + 1} — ${s.source || "Wire"}]:\n${s.text || ""}`).join("\n\n")
      : String(sources || "");
    return this.complete(
      "You are the senior markets editor of Morning Brief (LSEG Morning News Call style). Write one dense 80-90 word paragraph covering WHAT happened (with numbers and attribution), WHY it matters (the market/earnings mechanism), and WHAT is next (the specific catalyst).",
      `Headline: ${headline}\n${marketContext ? `Live Quotes: ${marketContext}\n` : ""}\nSources:\n${sourceText}`,
      { maxTokens: 320 }
    );
  }
}
