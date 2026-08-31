// Shared ledger arithmetic, the clairvoyant ceiling/floor, and a permutation
// significance test. Depends on window.Backtest and window.PowerLaw for the
// monthStarts/closeOn/fairValueSeries adapters below.
//
// backtest.js's runLedger() calls simulateLedger() here for the actual
// spend/balance/btc bookkeeping, so there is exactly one implementation of
// "how money becomes BTC" — two independent copies would drift apart and
// quietly invalidate every comparison this file makes.
(function (global) {
  "use strict";

  const B = global.Backtest;
  const PL = global.PowerLaw;

  /* ---------------------------------------------------------------- *
   * Shared ledger
   * ---------------------------------------------------------------- */

  // @param prices               Float64Array|number[] close on each purchase date
  // @param multipliers          Float64Array|number[] applied multiplier per month (post-clamp)
  // @param deposit              fixed monthly deposit
  // @param opts.debug           if true, asserts deposited == invested + balance every month
  // @param opts.startingBalance initial cash reserve before the first deposit, default 0
  function simulateLedger(prices, multipliers, deposit, opts) {
    const debug = opts && opts.debug;
    const startingBalance = (opts && opts.startingBalance) || 0;
    const n = prices.length;
    if (n === 0) {
      return {
        btc: 0,
        invested: 0,
        deposited: 0,
        cashLeft: 0,
        btcValue: 0,
        totalValue: 0,
        starvedMonths: 0,
        unmetDemand: 0,
        maxReserve: 0,
        balanceTrace: new Float64Array(0),
        spendTrace: new Float64Array(0),
        btcTrace: new Float64Array(0),
        starvedTrace: new Uint8Array(0),
      };
    }

    let balance = startingBalance;
    let btc = 0;
    let invested = 0;
    let deposited = 0;
    let starvedMonths = 0;
    let unmetDemand = 0;
    let maxReserve = 0;
    const balanceTrace = new Float64Array(n);
    const spendTrace = new Float64Array(n);
    const btcTrace = new Float64Array(n);
    const starvedTrace = new Uint8Array(n);

    for (let t = 0; t < n; t++) {
      balance += deposit;
      deposited += deposit;

      const desired = deposit * multipliers[t];
      const spend = Math.min(desired, balance);

      if (spend < desired - 0.005) {
        starvedMonths++;
        unmetDemand += desired - spend;
        starvedTrace[t] = 1;
      }

      btc += spend / prices[t];
      balance -= spend;
      invested += spend;

      spendTrace[t] = spend;
      btcTrace[t] = btc;
      balanceTrace[t] = balance;
      if (balance > maxReserve) maxReserve = balance;

      if (debug && Math.abs(startingBalance + deposited - (invested + balance)) > 1e-6) {
        throw new Error(
          `Ledger conservation violated at month ${t}: startingBalance=${startingBalance} deposited=${deposited} invested=${invested} balance=${balance}`
        );
      }
    }

    const finalPrice = prices[n - 1];
    return {
      btc,
      invested,
      deposited,
      cashLeft: balance,
      btcValue: btc * finalPrice,
      totalValue: btc * finalPrice + balance,
      starvedMonths,
      unmetDemand,
      maxReserve,
      balanceTrace,
      spendTrace,
      btcTrace,
      starvedTrace,
    };
  }

  /* ---------------------------------------------------------------- *
   * 1. Clairvoyant ceiling and floor
   * ---------------------------------------------------------------- */

  // Perfect-hindsight allocation under the real cash constraint: money
  // deposited in month t can only be spent in month t or later.
  //
  // Each dollar is independent (no per-month capacity limit), so the optimum
  // is simply: every dollar deposited at t goes to argmin(price) over [t, T].
  // One suffix scan, exact, O(n).
  //
  // mode 'best'  -> ceiling: the most BTC any timing rule could possibly buy
  // mode 'worst' -> floor:   the least, by always waiting for the worst price ahead
  function perfectTiming(prices, deposit, mode) {
    mode = mode || "best";
    const n = prices.length;
    const targetIdx = new Int32Array(n);

    let ext = n - 1;
    targetIdx[n - 1] = ext;
    for (let t = n - 2; t >= 0; t--) {
      const isBetter = mode === "best" ? prices[t] <= prices[ext] : prices[t] >= prices[ext];
      if (isBetter) ext = t;
      targetIdx[t] = ext;
    }

    const spendAt = new Float64Array(n);
    for (let t = 0; t < n; t++) spendAt[targetIdx[t]] += deposit;

    let btc = 0;
    for (let s = 0; s < n; s++) {
      if (spendAt[s] > 0) btc += spendAt[s] / prices[s];
    }

    const totalDeposited = deposit * n;
    return { btc, avgCost: totalDeposited / btc, spendAt, targetIdx };
  }

  // How much of the theoretically available edge a strategy actually captured.
  // 0.0 = no better than DCA, 1.0 = perfect foresight, < 0 = worse than DCA.
  function captureRatio(strategyBtc, dcaBtc, ceilingBtc) {
    const headroom = ceilingBtc - dcaBtc;
    if (headroom <= 0) return null;
    return (strategyBtc - dcaBtc) / headroom;
  }

  /* ---------------------------------------------------------------- *
   * 2. Permutation test
   * ---------------------------------------------------------------- */

  // Keeps the exact multipliers a strategy produced, but shuffles WHICH
  // month each one lands on. If the real chronological ordering does not
  // beat most shuffled orderings, the power law is contributing nothing —
  // the result comes from the distribution of multiplier sizes, not from
  // their timing.
  function permutationTest(prices, multipliers, deposit, iterations, rng) {
    iterations = iterations || 2000;
    rng = rng || mulberry32(42);
    const observed = simulateLedger(prices, multipliers, deposit);
    const n = multipliers.length;
    const shuffled = Float64Array.from(multipliers);
    const nullBtc = new Float64Array(iterations);

    for (let i = 0; i < iterations; i++) {
      for (let j = n - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        const tmp = shuffled[j];
        shuffled[j] = shuffled[k];
        shuffled[k] = tmp;
      }
      nullBtc[i] = simulateLedger(prices, shuffled, deposit).btc;
    }

    let atOrAbove = 0;
    for (let i = 0; i < iterations; i++) if (nullBtc[i] >= observed.btc) atOrAbove++;

    const sorted = Float64Array.from(nullBtc).sort();
    const mean = sorted.reduce((a, b) => a + b, 0) / iterations;
    const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (iterations - 1);

    return {
      observedBtc: observed.btc,
      nullBtc: sorted,
      pValue: (atOrAbove + 1) / (iterations + 1),
      percentile: 100 * (1 - atOrAbove / iterations),
      nullMean: mean,
      nullSd: Math.sqrt(variance),
      nullP05: sorted[Math.floor(0.05 * iterations)],
      nullP95: sorted[Math.floor(0.95 * iterations)],
    };
  }

  // Small seeded PRNG so runs are reproducible.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(x, lo, hi) {
    return Math.min(Math.max(x, lo), hi);
  }

  /* ---------------------------------------------------------------- *
   * Adapters onto the existing Backtest/PowerLaw API
   * ---------------------------------------------------------------- */

  function monthStarts(startDate, endDate) {
    return B.monthStarts(startDate, endDate);
  }

  // Plain number, unlike Backtest.closeOn which returns {price, dateUsed}.
  function closeOn(date) {
    const info = B.closeOn(global.BTC_DATA, date);
    return info ? info.price : null;
  }

  // dates must be a contiguous ascending run of month-starts (as produced by
  // monthStarts) — the context this builds spans [dates[0], dates[last]].
  function fairValueSeries(dates, fitMode) {
    if (dates.length === 0) return [];
    const context = B.prepareFairValueContext(global.BTC_DATA, dates[0], dates[dates.length - 1], fitMode);
    return dates.map((d) => {
      const row = context.plFairByDate.get(d);
      if (!row) throw new Error(`No power-law fair value computed for ${d}`);
      return row.plFair;
    });
  }

  // A single scalar k for the window passed in — median-based self
  // calibration over exactly that data. This is deliberately simpler than
  // the main app's annual, trailing, no-lookahead k: callers here (the
  // benchmark suite, each rolling window) always pass one self-contained
  // window, not a date to recompute at, so there's no "future" data to
  // guard against within the window itself.
  function calibrationConstant(fairArr, pricesArr, exponent, datesArr) {
    if (exponent === 0) return 1;
    const ratios = [];
    for (let i = 0; i < fairArr.length; i++) {
      ratios.push(Math.pow(fairArr[i] / pricesArr[i], exponent));
    }
    return ratios.length > 0 ? 1 / B.median(ratios) : 1;
  }

  /* ---------------------------------------------------------------- *
   * Orchestration
   * ---------------------------------------------------------------- */

  // cfg: {startDate, endDate, deposit, fitMode, calibrate,
  //       strategies: [{name, exponent, mMin, mMax}]}
  function runBenchmarkSuite(cfg) {
    const dates = monthStarts(cfg.startDate, cfg.endDate);
    if (dates.length === 0) {
      throw new Error("Selected date range contains no month-start purchase dates.");
    }
    const prices = Float64Array.from(dates, closeOn);
    const fair = Float64Array.from(fairValueSeries(dates, cfg.fitMode));

    const ceiling = perfectTiming(prices, cfg.deposit, "best");
    const floor = perfectTiming(prices, cfg.deposit, "worst");

    const ones = new Float64Array(prices.length).fill(1);
    const dca = simulateLedger(prices, ones, cfg.deposit);

    const results = cfg.strategies.map((s) => {
      const k = cfg.calibrate ? calibrationConstant(fair, prices, s.exponent, dates) : 1;
      const mult = Float64Array.from(prices, (p, i) => clamp(k * Math.pow(fair[i] / p, s.exponent), s.mMin, s.mMax));
      const run = simulateLedger(prices, mult, cfg.deposit);
      return {
        name: s.name,
        run,
        multipliers: mult,
        deltaVsDcaPct: 100 * (run.btc / dca.btc - 1),
        capture: captureRatio(run.btc, dca.btc, ceiling.btc),
        permutation: permutationTest(prices, mult, cfg.deposit),
      };
    });

    return {
      dates,
      prices,
      dca,
      ceiling,
      floor,
      maxPossibleEdgePct: 100 * (ceiling.btc / dca.btc - 1),
      minPossibleEdgePct: 100 * (floor.btc / dca.btc - 1),
      results,
    };
  }

  global.Benchmarks = {
    simulateLedger,
    perfectTiming,
    captureRatio,
    permutationTest,
    mulberry32,
    clamp,
    monthStarts,
    closeOn,
    fairValueSeries,
    calibrationConstant,
    runBenchmarkSuite,
  };
})(typeof window !== "undefined" ? window : globalThis);
