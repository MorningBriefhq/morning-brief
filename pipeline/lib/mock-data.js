// Morning Brief pipeline — canned data for mock mode.
// Used by the worker when API keys are unset, and by local-run.js / tests.
// Headlines are written date-agnostically so samples always read plausibly.

export const MOCK_ARTICLES = {
  NVDA: [
    {
      datetime: 0,
      headline: "Nvidia unveils next-gen AI chip roadmap, shares climb in late trading",
      source: "Reuters",
      summary:
        "Nvidia laid out its next-generation AI accelerator roadmap at an industry event, promising meaningful performance-per-watt gains. Analysts said the timeline keeps the company ahead of rival offerings into next year.",
      url: "",
    },
    {
      datetime: 0,
      headline: "Cloud providers expand Nvidia GPU orders as AI demand stays hot",
      source: "Bloomberg",
      summary:
        "Two large cloud providers disclosed expanded purchase agreements for Nvidia's data-center GPUs, citing sustained enterprise AI demand. The orders extend visibility into the next two quarters.",
      url: "",
    },
  ],
  AAPL: [
    {
      datetime: 0,
      headline: "Apple services revenue hits record as hardware growth cools",
      source: "Wall Street Journal",
      summary:
        "Apple's services division posted record quarterly revenue, offsetting softer iPhone unit growth. Management pointed to installed-base monetization as the durable growth driver.",
      url: "",
    },
  ],
  JPM: [
    {
      datetime: 0,
      headline: "JPMorgan raises dividend, cites strong capital position",
      source: "CNBC",
      summary:
        "JPMorgan's board approved a dividend increase, citing a strong capital position and resilient credit performance. The bank also authorized a new share-repurchase program.",
      url: "",
    },
    {
      datetime: 0,
      headline: "JPMorgan trading desks post strong quarter on volatile markets",
      source: "Financial Times",
      summary:
        "JPMorgan's markets division benefited from elevated trading volumes amid rate volatility. Executives said client activity remained robust across fixed income and equities.",
      url: "",
    },
  ],
  TSLA: [
    {
      datetime: 0,
      headline: "Tesla deliveries beat estimates as price cuts lift demand",
      source: "Reuters",
      summary:
        "Tesla reported quarterly deliveries ahead of analyst estimates after a round of price cuts. Margins remain the open question heading into the earnings call.",
      url: "",
    },
  ],
  MSFT: [
    {
      datetime: 0,
      headline: "Microsoft expands Copilot enterprise deals, Azure growth reaccelerates",
      source: "Bloomberg",
      summary:
        "Microsoft signed a wave of enterprise Copilot agreements while Azure revenue growth reaccelerated. Analysts highlighted AI workloads as the key driver.",
      url: "",
    },
  ],
  AMZN: [
    {
      datetime: 0,
      headline: "Amazon AWS wins large government cloud contract",
      source: "Wall Street Journal",
      summary:
        "Amazon Web Services secured a multi-year government cloud contract, extending its public-sector momentum. The deal adds to a strong backlog for the unit.",
      url: "",
    },
  ],
};

export const MOCK_MARKET = {
  topNews: [
    {
      headline: "Fed officials signal patience on rates as inflation cools gradually",
      summary:
        "Federal Reserve officials struck a patient tone in overnight remarks, saying inflation is cooling but they want more evidence before adjusting policy. Markets now price the next move for later in the year. The comments suggest the central bank is in no hurry to cut rates, with officials emphasizing data dependence and the need to see sustained progress toward the 2% target before acting.",
    },
    {
      headline: "Mega-cap tech leads as AI spending plans hold firm",
      summary:
        "Large technology shares outperformed after several bellwethers reaffirmed capital spending plans tied to artificial intelligence. Analysts say enterprise AI budgets look resilient into next year. The spending commitments provide reassurance that the AI investment cycle remains intact, with cloud providers and chipmakers both signaling continued demand strength through 2027.",
    },
    {
      headline: "Oil steady as traders weigh supply signals against soft demand data",
      summary:
        "Crude prices held in a narrow range as traders balanced OPEC supply commentary against weaker-than-expected demand indicators from major importers. The market is waiting for clearer signals on whether production cuts will be extended, while inventory data due later this week could provide direction. Analysts note the backwardation structure suggests near-term tightness despite demand concerns.",
    },
    {
      headline: "Banks kick off earnings season with trading strength in focus",
      summary:
        "Big banks begin reporting this week, with investors watching trading revenue and credit quality for signals on the health of capital markets activity. Expectations are for solid fixed-income trading results given elevated volatility, while loan loss provisions will be scrutinized for any deterioration in consumer or commercial credit. Net interest income trends remain key as the rate environment evolves.",
    },
    {
      headline: "Dollar eases as global central banks diverge on policy paths",
      summary:
        "The dollar slipped modestly as policy expectations diverged across major central banks, with traders positioning ahead of a busy data calendar. The ECB's more dovish stance contrasts with the Fed's patience, creating two-way risk in EUR/USD. Emerging market currencies found some relief, though analysts caution that the dollar's structural bid remains intact given U.S. growth outperformance.",
    },
  ],
  beforeBell: [
    { label: "Futures", text: "S&P 500 futures pointed to a modestly higher open, up about 0.3%, with Nasdaq futures outperforming on tech strength." },
    { label: "Oil", text: "WTI crude held near recent levels as traders awaited fresh inventory data due later this week." },
    { label: "Gold", text: "Gold edged higher as a softer dollar supported the metal ahead of key inflation readings." },
    { label: "Dollar", text: "The dollar index slipped 0.2% as rate-cut expectations repriced across major economies." },
    { label: "Europe", text: "European shares opened firmer, tracking overnight gains in U.S. tech and steady energy prices." },
    { label: "Asia", text: "Asian markets closed mixed, with AI-linked shares leading gains while property developers lagged." },
  ],
  calendar: {
    earnings: [
      { ticker: "JPM", company: "JPMorgan Chase", time: "{date} · Before open" },
      { ticker: "WFC", company: "Wells Fargo", time: "{date} · Before open" },
      { ticker: "NFLX", company: "Netflix", time: "{date} · After close" },
    ],
    econ: [
      { time_et: "8:30 AM ET", event: "Consumer Price Index (CPI)" },
      { time_et: "10:00 AM ET", event: "Consumer sentiment (preliminary)" },
      { time_et: "2:00 PM ET", event: "Federal budget balance" },
    ],
  },
};
