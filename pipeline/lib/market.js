// Morning Briefing pipeline — market-overview providers.
//
// Sections mirror the LSEG-style email template:
//   topNews(runDate)   -> [{headline, summary}]            (4-6 big stories)
//   beforeBell(runDate)-> [{label, text}]                  (Futures, Oil, Gold, Dollar, Europe, Asia)
//   calendar(runDate)  -> { earnings: [{ticker, company, time}],
//                           econ: [{time_et, event}] }
//
// MockMarketProvider: realistic canned data for testing; the run date is
// injected into the calendar so samples always look current.
// Real-data note: top stories can later come from Finnhub market-news or a news
// API; earnings from Finnhub /calendar/earnings; econ releases from a calendar
// API. The user's own agent-produced morning newsletter is also a candidate
// feed for these sections — see ARCHITECTURE.md.

export class MarketProvider {
  async topNews(_runDate) {
    throw new Error("MarketProvider.topNews not implemented");
  }
  async beforeBell(_runDate) {
    throw new Error("MarketProvider.beforeBell not implemented");
  }
  async calendar(_runDate) {
    throw new Error("MarketProvider.calendar not implemented");
  }
}

export class MockMarketProvider extends MarketProvider {
  constructor(mock) {
    super();
    this.mock = mock;
  }
  async topNews() {
    return this.mock.topNews.map((s) => ({ ...s }));
  }
  async beforeBell() {
    return this.mock.beforeBell.map((s) => ({ ...s }));
  }
  async calendar(runDate) {
    return {
      earnings: this.mock.calendar.earnings.map((e) => ({ ...e, time: e.time.replace("{date}", runDate) })),
      econ: this.mock.calendar.econ.map((e) => ({ ...e })),
    };
  }
  async mergers() {
    return (this.mock.mergers || []).map((s) => ({ ...s }));
  }
  async analysts() {
    return (this.mock.analysts || []).map((s) => ({ ...s }));
  }
  async pictureOfTheDay() {
    return null;
  }
}
