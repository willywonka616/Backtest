// Rolling-window robustness study: slides a fixed-length window across the
// whole series and produces the distribution of strategy-vs-DCA deltas.
// A single number over one full-period backtest is one observation; this is
// how you tell if it's typical or lucky.
//
// Depends on window.Benchmarks (js/benchmarks.js).
(function (global) {
  "use strict";

  const BM = global.Benchmarks;

  // cfg: {
  //   windowMonths (default 48), stepMonths (default 1),
  //   deposit, fitMode ('expanding'|'full'), calibrate,
  //   strategies: [{name, exponent, mMin, mMax}],
  //   dataStart, dataEnd  bounds of the usable series
  // }
  // Returns { windows, byStrategy, nonOverlapping, effectiveN }.
  function rollingWindowStudy(cfg) {
    const windowMonths = cfg.windowMonths || 48;
    const step = cfg.stepMonths || 1;

    // All month-starts available in the dataset, once.
    const allDates = BM.monthStarts(cfg.dataStart, cfg.dataEnd);
    const total = allDates.length;

    if (total < windowMonths) {
      throw new Error(
        `Selected period (${total} months) is shorter than the rolling window (${windowMonths} months). ` +
          `Pick a shorter window or a longer period.`
      );
    }

    const allPrices = Float64Array.from(allDates, BM.closeOn);

    // Fair value at date t under the expanding fit does not depend on which
    // window t belongs to, so compute the whole series once and slice it per
    // window. Recomputing inside the loop turns a 200ms job into a 30s one.
    const allFair = Float64Array.from(BM.fairValueSeries(allDates, cfg.fitMode));

    const windows = [];

    for (let start = 0; start + windowMonths <= total; start += step) {
      const end = start + windowMonths;
      const prices = allPrices.subarray(start, end);
      const fair = allFair.subarray(start, end);

      const ones = new Float64Array(windowMonths).fill(1);
      const dca = BM.simulateLedger(prices, ones, cfg.deposit);

      const perStrategy = cfg.strategies.map((s) => {
        const k = cfg.calibrate
          ? BM.calibrationConstant(fair, prices, s.exponent, allDates.slice(start, end))
          : 1;
        const mult = Float64Array.from(prices, (p, i) => BM.clamp(k * Math.pow(fair[i] / p, s.exponent), s.mMin, s.mMax));
        const run = BM.simulateLedger(prices, mult, cfg.deposit);
        return {
          name: s.name,
          deltaBtcPct: 100 * (run.btc / dca.btc - 1),
          deltaValuePct: 100 * (run.totalValue / dca.totalValue - 1),
          starvedPct: (100 * run.starvedMonths) / windowMonths,
          meanMultiplier: mult.reduce((a, b) => a + b, 0) / windowMonths,
        };
      });

      windows.push({
        startIdx: start,
        startDate: allDates[start],
        endDate: allDates[end - 1],
        dcaBtc: dca.btc,
        priceStart: prices[0],
        priceEnd: prices[windowMonths - 1],
        strategies: perStrategy,
      });
    }

    // Per-strategy summary across all windows.
    const byStrategy = cfg.strategies.map((s, si) => {
      const deltas = windows.map((w) => w.strategies[si].deltaBtcPct);
      return { name: s.name, deltas, ...describe(deltas) };
    });

    // Non-overlapping subset — closer to independent observations.
    const nonOverlapping = windows.filter((w) => w.startIdx % windowMonths === 0);

    return {
      windows,
      byStrategy,
      nonOverlapping,
      // Consecutive windows share almost all their months, so N windows is
      // not N samples. This is roughly how many genuinely independent ones
      // there are.
      effectiveN: Math.floor(total / windowMonths),
    };
  }

  function describe(xs) {
    const sorted = [...xs].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) {
      return { n: 0, mean: null, sd: null, median: null, min: null, max: null, p05: null, p25: null, p75: null, p95: null, winRate: null };
    }
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
    return {
      n,
      mean,
      sd,
      median: q(0.5),
      min: sorted[0],
      max: sorted[n - 1],
      p05: q(0.05),
      p25: q(0.25),
      p75: q(0.75),
      p95: q(0.95),
      winRate: (100 * xs.filter((x) => x > 0).length) / n,
    };
  }

  // Bin the deltas for a histogram.
  function histogram(values, binWidth) {
    binWidth = binWidth || 0.5;
    if (values.length === 0) return [];
    const lo = Math.floor(Math.min(...values) / binWidth) * binWidth;
    const hi = Math.ceil(Math.max(...values) / binWidth) * binWidth;
    const bins = [];
    for (let x = lo; x < hi; x += binWidth) bins.push({ x0: x, x1: x + binWidth, count: 0 });
    if (bins.length === 0) bins.push({ x0: lo, x1: lo + binWidth, count: 0 });
    for (const v of values) {
      const i = Math.min(bins.length - 1, Math.floor((v - lo) / binWidth));
      bins[i].count++;
    }
    return bins;
  }

  global.Rolling = { rollingWindowStudy, describe, histogram };
})(typeof window !== "undefined" ? window : globalThis);
