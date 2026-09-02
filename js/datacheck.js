// Verifies js/data.js against a live source without you needing to know any
// price by heart. CoinGecko's free endpoint serves the last 365 days; if the
// committed file overlaps that window and matches, the recent data is real.
// If it diverges by more than rounding, the file was not fetched from an
// exchange.
//
// Runs in the browser. Under file:// the fetch is blocked by CORS (see the
// docstring on verifyAgainstLive below) — that failure is expected there and
// must not be treated as "verification failed", only as "unverified".
(function (global) {
  "use strict";

  const COINGECKO_URL =
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart" + "?vs_currency=usd&days=365&interval=daily";

  // @returns {{overlapDays, medianAbsPct, maxAbsPct, worst, verdict, series}}
  // Throws if the network request itself fails (no internet, CORS under
  // file://, CoinGecko rate limit) — callers must treat that as "unverified",
  // not as a verification failure.
  async function verifyAgainstLive(data) {
    data = data || global.BTC_DATA;
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    const json = await res.json();

    // [[ms, price], ...] -> {'YYYY-MM-DD': price}
    const live = new Map();
    for (const [ms, price] of json.prices) {
      live.set(new Date(ms).toISOString().slice(0, 10), price);
    }

    const localStart = new Date(data.startDate + "T00:00:00Z");
    const local = new Map();
    for (let i = 0; i < data.closes.length; i++) {
      const d = new Date(localStart.getTime() + i * 86400000);
      local.set(d.toISOString().slice(0, 10), data.closes[i]);
    }

    const rows = [];
    for (const [date, livePrice] of live) {
      if (!local.has(date)) continue;
      const localPrice = local.get(date);
      rows.push({
        date,
        live: livePrice,
        local: localPrice,
        absPct: (100 * Math.abs(localPrice - livePrice)) / livePrice,
      });
    }

    if (rows.length === 0) {
      return {
        overlapDays: 0,
        verdict:
          "NO OVERLAP — your series ends before the live window starts. " +
          "That gap is itself the finding: the file is not current.",
        series: [],
      };
    }

    rows.sort((a, b) => a.date.localeCompare(b.date));
    const absPcts = [...rows].map((r) => r.absPct).sort((a, b) => a - b);
    const medianAbsPct = absPcts[Math.floor(absPcts.length / 2)];
    const worst = rows.reduce((a, b) => (b.absPct > a.absPct ? b : a));

    // Daily closes differ slightly between venues and snapshot times. Under
    // ~2% is normal disagreement. Above ~10% is not a different exchange, it
    // is a different history.
    let verdict;
    if (medianAbsPct < 2) verdict = "PASS — matches a live source within normal venue variation.";
    else if (medianAbsPct < 10) verdict = "SUSPECT — larger than venue variation. Check timestamp alignment, then the source.";
    else verdict = "FAIL — this series does not describe real market history.";

    return { overlapDays: rows.length, medianAbsPct, maxAbsPct: worst.absPct, worst, verdict, series: rows };
  }

  // Independent anchors, useful for years CoinGecko's free tier will not
  // serve. Daily closes vary a little by venue, so allow a few percent —
  // these are for catching a fabricated series, not for calibration.
  //
  // The all-time high is the sharpest test: a generated series almost never
  // puts the peak on the right date at the right level.
  const ANCHORS = [
    { date: "2025-10-07", price: 126200, tolerancePct: 4, note: "all-time high" },
    { date: "2026-08-31", price: 78100, tolerancePct: 5, note: "roughly 38% below the peak" },
  ];

  function checkAnchors(data) {
    data = data || global.BTC_DATA;
    const start = new Date(data.startDate + "T00:00:00Z");
    return ANCHORS.map((a) => {
      const idx = Math.round((new Date(a.date + "T00:00:00Z") - start) / 86400000);
      const local = data.closes[idx];
      if (local === undefined) {
        return { ...a, local: null, pass: false, detail: "date is outside the committed series" };
      }
      const devPct = (100 * Math.abs(local - a.price)) / a.price;
      return { ...a, local, devPct, pass: devPct <= a.tolerancePct };
    });
  }

  // Also worth running regardless of source: does the series behave like a
  // real price? Fabricated series are usually too smooth.
  function shapeDiagnostics(data) {
    data = data || global.BTC_DATA;
    const c = data.closes;
    const rets = [];
    for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));

    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    const annualVol = 100 * sd * Math.sqrt(365);

    // Real BTC daily returns exceed 5% on roughly 3-5% of days and have fat tails.
    const bigMoves = (100 * rets.filter((r) => Math.abs(r) > 0.05).length) / rets.length;
    const kurtosis = rets.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / rets.length;

    // Repeated identical closes suggest forward-filled or padded data.
    let repeats = 0;
    for (let i = 1; i < c.length; i++) if (c[i] === c[i - 1]) repeats++;

    return {
      annualVol, // expect roughly 45-75%
      bigMovePct: bigMoves, // expect roughly 3-5%
      kurtosis, // expect well above 3; near 3 means synthetic
      repeatedClosePct: (100 * repeats) / c.length,
      lastDate: new Date(new Date(data.startDate + "T00:00:00Z").getTime() + (c.length - 1) * 86400000)
        .toISOString()
        .slice(0, 10),
      lastClose: c[c.length - 1],
    };
  }

  // Finds the actual all-time-high in the committed series: the single most
  // diagnostic check available offline — a fabricated or forward-filled
  // series almost never places its peak on the right date at the right
  // level (see ANCHORS' "all-time high" entry, which this is compared
  // against by the caller).
  function findATH(data) {
    data = data || global.BTC_DATA;
    const start = new Date(data.startDate + "T00:00:00Z");
    let bestIdx = 0;
    let bestPrice = -Infinity;
    for (let i = 0; i < data.closes.length; i++) {
      const c = data.closes[i];
      if (c != null && c > bestPrice) {
        bestPrice = c;
        bestIdx = i;
      }
    }
    const date = new Date(start.getTime() + bestIdx * 86400000).toISOString().slice(0, 10);
    return { price: bestPrice, date };
  }

  // Cheap, offline structural health of the committed series: how many
  // calendar days had to be forward-filled at generation time (see
  // tools/fetch-data.mjs — BTC_DATA.fillCount, 0 if the field predates this
  // check or the source was already contiguous), and how many closes are
  // missing or non-positive (a zero/negative price is never real market
  // data, whatever the source).
  function dataHealth(data) {
    data = data || global.BTC_DATA;
    const c = data.closes;
    let zeroOrNegativeCount = 0;
    for (const price of c) {
      if (price == null || price <= 0) zeroOrNegativeCount++;
    }
    const lastDate = new Date(
      new Date(data.startDate + "T00:00:00Z").getTime() + (c.length - 1) * 86400000
    )
      .toISOString()
      .slice(0, 10);
    return {
      rows: c.length,
      lastDate,
      lastClose: c[c.length - 1],
      gapDays: data.fillCount || 0,
      zeroOrNegativeCount,
    };
  }

  // Days between the series' last date and `now` (defaults to the real
  // wall-clock time). A committed snapshot more than a few days stale means
  // every chart and metric on the page is describing a market that has
  // since moved on.
  function staleDays(lastDateStr, now) {
    now = now || new Date();
    const last = new Date(lastDateStr + "T00:00:00Z");
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return Math.round((today.getTime() - last.getTime()) / 86400000);
  }

  global.DataCheck = { verifyAgainstLive, checkAnchors, shapeDiagnostics, findATH, dataHealth, staleDays, ANCHORS };
})(typeof window !== "undefined" ? window : globalThis);
