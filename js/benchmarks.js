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

  // @param prices                  Float64Array|number[] close on each purchase date
  // @param multipliers             Float64Array|number[] applied multiplier per month (post-clamp)
  // @param deposit                 fixed monthly deposit
  // @param opts.debug              if true, asserts the ledger-conservation identity every month
  // @param opts.fundingMode        'strict' (default): spend = min(desired, balance), balance >= 0.
  //                                 'seeded': same rule, but balance starts at startingCapital.
  //                                 'unbound': spend = desired always, balance may go negative.
  //                                 Diagnostic only — never a runnable strategy.
  // @param opts.startingCapital    initial cash reserve, honored under 'seeded'/'unbound' (default 0;
  //                                 'strict' always starts at 0 by definition)
  // @param opts.reserveRateAnnual  annual yield credited to the balance monthly before that month's
  //                                 deposit, compounded (default 0 — cash held in reserve earns nothing
  //                                 unless this is set; that zero is a real assumption, not a given)
  function simulateLedger(prices, multipliers, deposit, opts) {
    opts = opts || {};
    const debug = opts.debug;
    const fundingMode = opts.fundingMode || "strict";
    const startingCapital = opts.startingCapital || 0;
    const reserveRateAnnual = opts.reserveRateAnnual || 0;
    const monthlyRate = Math.pow(1 + reserveRateAnnual, 1 / 12) - 1;
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
        maxDrawdownOnBalance: 0,
        monthsNegative: 0,
        balanceTrace: new Float64Array(0),
        spendTrace: new Float64Array(0),
        btcTrace: new Float64Array(0),
        starvedTrace: new Uint8Array(0),
      };
    }

    let balance = fundingMode === "strict" ? 0 : startingCapital;
    let btc = 0;
    let invested = 0;
    let deposited = 0;
    let interestAccrued = 0;
    let starvedMonths = 0;
    let unmetDemand = 0;
    let maxReserve = 0;
    let minBalance = balance;
    let monthsNegative = 0;
    const balanceTrace = new Float64Array(n);
    const spendTrace = new Float64Array(n);
    const btcTrace = new Float64Array(n);
    const starvedTrace = new Uint8Array(n);

    for (let t = 0; t < n; t++) {
      const interest = balance * monthlyRate;
      balance += interest;
      interestAccrued += interest;

      balance += deposit;
      deposited += deposit;

      const desired = deposit * multipliers[t];
      const spend = fundingMode === "unbound" ? desired : Math.min(desired, balance);

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
      if (balance < minBalance) minBalance = balance;
      if (balance < 0) monthsNegative++;

      if (debug) {
        const startBal = fundingMode === "strict" ? 0 : startingCapital;
        const expected = startBal + deposited + interestAccrued - invested;
        if (Math.abs(expected - balance) > 1e-6) {
          throw new Error(
            `Ledger conservation violated at month ${t}: startingCapital=${startBal} deposited=${deposited} ` +
              `interestAccrued=${interestAccrued} invested=${invested} balance=${balance} (expected ${expected})`
          );
        }
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
      // The most negative the balance went — the size of the loan an 'unbound'
      // run would have required. 0 if it never went negative.
      maxDrawdownOnBalance: Math.min(0, minBalance),
      monthsNegative,
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
  function perfectTiming(prices, deposit, mode, extraCapitalAtStart) {
    mode = mode || "best";
    extraCapitalAtStart = extraCapitalAtStart || 0;
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
    if (extraCapitalAtStart) spendAt[targetIdx[0]] += extraCapitalAtStart;

    let btc = 0;
    for (let s = 0; s < n; s++) {
      if (spendAt[s] > 0) btc += spendAt[s] / prices[s];
    }

    const totalDeposited = deposit * n + extraCapitalAtStart;
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
  //
  // Also collects starvedMonths and invested per shuffle (not just btc), so
  // a real-vs-shuffled table can show whether an observed edge is a timing
  // effect or just a deployment effect. ledgerOpts is passed straight to
  // simulateLedger for every run (real and shuffled alike) — pass
  // {fundingMode: 'unbound'} to answer "is the funding constraint what
  // destroys the signal": if p flips from ~1 under 'strict' to <0.01 under
  // 'unbound', the constraint was the problem, not the model.
  //
  // LEGACY — invalid for path-dependent strategies (threshold). A
  // threshold strategy's multiplier at month t depends on the reserve
  // balance carried in from every earlier month, so the multiplier ARRAY
  // itself encodes that history; permuting it directly produces sequences
  // of multipliers the strategy could never actually have produced (e.g. a
  // "spend from reserve" month with no reserve behind it). Kept only for
  // the legacy-toggle comparison — see signalPermutationTest below for the
  // valid replacement, used everywhere by default.
  function permutationTest(prices, multipliers, deposit, iterations, rng, ledgerOpts) {
    iterations = iterations || 2000;
    rng = rng || mulberry32(42);
    const observed = simulateLedger(prices, multipliers, deposit, ledgerOpts);
    const n = multipliers.length;
    const shuffled = Float64Array.from(multipliers);
    const nullBtc = new Float64Array(iterations);
    const nullStarved = new Float64Array(iterations);
    const nullInvested = new Float64Array(iterations);

    for (let i = 0; i < iterations; i++) {
      for (let j = n - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        const tmp = shuffled[j];
        shuffled[j] = shuffled[k];
        shuffled[k] = tmp;
      }
      const run = simulateLedger(prices, shuffled, deposit, ledgerOpts);
      nullBtc[i] = run.btc;
      nullStarved[i] = run.starvedMonths;
      nullInvested[i] = run.invested;
    }

    const meanOf = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const deploymentRateOf = (invested) => (observed.deposited > 0 ? invested / observed.deposited : null);
    const stats = summarizeNull(nullBtc, observed.btc);

    return {
      observedBtc: observed.btc,
      observedStarvedMonths: observed.starvedMonths,
      observedInvested: observed.invested,
      observedDeploymentRate: deploymentRateOf(observed.invested),
      nullBtc: stats.sorted,
      nullMeanStarvedMonths: meanOf(nullStarved),
      nullMeanInvested: meanOf(nullInvested),
      nullMeanDeploymentRate: deploymentRateOf(meanOf(nullInvested)),
      pValue: stats.pValue,
      percentile: stats.percentile,
      nullMean: stats.mean,
      nullSd: stats.sd,
      nullP05: stats.p05,
      nullP95: stats.p95,
    };
  }

  // One-sided (>=) p-value/percentile/mean/sd/p05/p95 for a null distribution
  // against one observed value. Shared by the legacy multiplier-permutation
  // test and the signal-permutation test below, once per metric each.
  function summarizeNull(nullArr, observedValue) {
    const iterations = nullArr.length;
    let atOrAbove = 0;
    for (let i = 0; i < iterations; i++) if (nullArr[i] >= observedValue) atOrAbove++;
    const sorted = Float64Array.from(nullArr).sort();
    const mean = sorted.reduce((a, b) => a + b, 0) / iterations;
    const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (iterations - 1);
    return {
      sorted,
      pValue: (atOrAbove + 1) / (iterations + 1),
      percentile: 100 * (1 - atOrAbove / iterations),
      mean,
      sd: Math.sqrt(variance),
      p05: sorted[Math.floor(0.05 * iterations)],
      p95: sorted[Math.floor(0.95 * iterations)],
    };
  }

  // Splits `src` into contiguous blocks of `blockSize` elements (the final
  // block may be shorter) and returns a new array with the BLOCK ORDER
  // shuffled — each block's internal sequence is left untouched. This keeps
  // whatever regime persistence a real 12-month stretch has (a real
  // multi-month over/undervaluation run) intact within every replicate;
  // only WHICH stretch lands WHEN is randomized. An element-wise shuffle
  // would erase that persistence and bias every replicate toward the
  // sample mean instead.
  function blockShuffle(src, blockSize, rng) {
    const n = src.length;
    const blockCount = Math.ceil(n / blockSize);
    const order = new Array(blockCount);
    for (let i = 0; i < blockCount; i++) order[i] = i;
    for (let j = blockCount - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      const tmp = order[j];
      order[j] = order[k];
      order[k] = tmp;
    }
    const out = new Float64Array(n);
    let pos = 0;
    for (const b of order) {
      const start = b * blockSize;
      const end = Math.min(start + blockSize, n);
      for (let i = start; i < end; i++) out[pos++] = src[i];
    }
    return out;
  }

  // Signal permutation test — the valid replacement for permutationTest
  // above, and the default everywhere. Shuffles the fair/price RATIO series
  // (the one primitive every strategy type derives its multiplier from),
  // in contiguous 12-month blocks with a seeded RNG, and for every replicate
  // reruns the ENTIRE strategy from scratch: buildStrategyMultipliers
  // (calibration + clamps, recomputed on the shuffled signal — a threshold
  // strategy's residual-band sigma included) and then the ledger. A
  // threshold run's null replicates are therefore genuine threshold runs
  // with their own real reserve history, not replayed multipliers.
  //
  // Records both BTC and total value per replicate and reports p-value +
  // percentile for each, since a strategy that ties DCA on BTC accumulated
  // but differs on cash left over (e.g. from starvation) is a different
  // claim than one that beats DCA on BTC alone.
  //
  // s: same strategy spec as buildStrategyMultipliers's `s` (including
  // s.lumpSumAtStart, applied via runWithLumpSum exactly like the real run).
  function signalPermutationTest(fair, prices, deposit, s, fundingOpts, opts) {
    opts = opts || {};
    const iterations = opts.iterations || 2000;
    const blockSize = opts.blockSize || 12;
    const rng = opts.rng || mulberry32(opts.seed == null ? 42 : opts.seed);
    const n = prices.length;

    const ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) ratio[i] = fair[i] / prices[i];

    function runFor(ratioArr) {
      const fairArr = new Float64Array(n);
      for (let i = 0; i < n; i++) fairArr[i] = ratioArr[i] * prices[i];
      const mult = buildStrategyMultipliers(fairArr, prices, deposit, s, fundingOpts);
      return runWithLumpSum(prices, mult, deposit, fundingOpts, !!s.lumpSumAtStart);
    }

    const observed = runFor(ratio);
    const nullBtc = new Float64Array(iterations);
    const nullTotalValue = new Float64Array(iterations);
    const nullStarved = new Float64Array(iterations);
    const nullInvested = new Float64Array(iterations);

    for (let i = 0; i < iterations; i++) {
      const shuffled = blockShuffle(ratio, blockSize, rng);
      const run = runFor(shuffled);
      nullBtc[i] = run.btc;
      nullTotalValue[i] = run.totalValue;
      nullStarved[i] = run.starvedMonths;
      nullInvested[i] = run.invested;
    }

    const meanOf = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const deploymentRateOf = (invested) => (observed.deposited > 0 ? invested / observed.deposited : null);
    const btcStats = summarizeNull(nullBtc, observed.btc);
    const valueStats = summarizeNull(nullTotalValue, observed.totalValue);

    return {
      blockSize,
      iterations,
      observedBtc: observed.btc,
      observedTotalValue: observed.totalValue,
      observedStarvedMonths: observed.starvedMonths,
      observedInvested: observed.invested,
      observedDeploymentRate: deploymentRateOf(observed.invested),

      // BTC stats, same field names as the legacy test so shared rendering
      // code can treat either result interchangeably for the BTC half.
      nullBtc: btcStats.sorted,
      pValue: btcStats.pValue,
      percentile: btcStats.percentile,
      nullMean: btcStats.mean,
      nullSd: btcStats.sd,
      nullP05: btcStats.p05,
      nullP95: btcStats.p95,

      // Total-value stats — new in the signal-permutation test.
      nullTotalValue: valueStats.sorted,
      pValueTotalValue: valueStats.pValue,
      percentileTotalValue: valueStats.percentile,
      nullMeanTotalValue: valueStats.mean,
      nullSdTotalValue: valueStats.sd,
      nullP05TotalValue: valueStats.p05,
      nullP95TotalValue: valueStats.p95,

      nullMeanStarvedMonths: meanOf(nullStarved),
      nullMeanInvested: meanOf(nullInvested),
      nullMeanDeploymentRate: deploymentRateOf(meanOf(nullInvested)),
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
  //
  // targetDeployment (default 1) generalizes the old "median == 1" rule to
  // "median == targetDeployment": with deposit held identical across every
  // strategy, this is how a reduced-deployment strategy is expressed —
  // never as a smaller deposit, which would make it a savings-rate
  // comparison instead of a timing comparison. Ignored (always 1) at
  // exponent 0: that slot is the DCA baseline and must stay the untouched
  // reference regardless of what any other strategy's dial is set to.
  function calibrationConstant(fairArr, pricesArr, exponent, datesArr, targetDeployment) {
    if (exponent === 0) return 1;
    targetDeployment = targetDeployment == null ? 1 : targetDeployment;
    const ratios = [];
    for (let i = 0; i < fairArr.length; i++) {
      ratios.push(Math.pow(fairArr[i] / pricesArr[i], exponent));
    }
    return ratios.length > 0 ? targetDeployment / B.median(ratios) : targetDeployment;
  }

  // Standard deviation of ln(price/fairValue) over the arrays passed in —
  // the width of the residual band around the power-law curve. Used to
  // express a threshold-strategy's "deep value zone" as "below -bandSigma
  // sigma" instead of a fixed ratio, which adapts as the fit changes.
  function residualSigma(fairArr, pricesArr) {
    const n = fairArr.length;
    if (n === 0) return 0;
    const resid = new Array(n);
    for (let i = 0; i < n; i++) resid[i] = Math.log(pricesArr[i] / fairArr[i]);
    const mean = resid.reduce((a, b) => a + b, 0) / n;
    const variance = resid.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return Math.sqrt(variance);
  }

  /* ---------------------------------------------------------------- *
   * Threshold reserve strategy
   * ---------------------------------------------------------------- */
  //
  // Unlike the continuous power-law multiplier, this rule's monthly desired
  // spend depends on the running reserve balance, which the ledger itself
  // produces — it can't be computed as a stateless .map() over prices the
  // way the power-law multiplier can. This runs its own forward pass, under
  // the same funding-mode bookkeeping as simulateLedger, to derive a
  // concrete per-month multiplier array; replaying that array through
  // simulateLedger with the same funding options reproduces this exact
  // run, so every downstream tool (permutation test, rolling windows,
  // benchmarks) treats a threshold strategy exactly like a power-law one
  // from that point on.
  //
  // params: { enterThreshold, baseRate, reserveSpendFraction, mMin, mMax }
  function computeThresholdMultiplierArray(prices, fairArr, deposit, params, fundingOpts) {
    fundingOpts = fundingOpts || {};
    const fundingMode = fundingOpts.fundingMode || "strict";
    const startingCapital = fundingOpts.startingCapital || 0;
    const reserveRateAnnual = fundingOpts.reserveRateAnnual || 0;
    const monthlyRate = Math.pow(1 + reserveRateAnnual, 1 / 12) - 1;
    const n = prices.length;
    const mult = new Float64Array(n);
    let balance = fundingMode === "strict" ? 0 : startingCapital;

    // enterThreshold may be a single number (applied to every month) or an
    // array parallel to prices/fairArr (a per-month value, e.g. from a
    // residual-band definition that adapts over time).
    const thresholdAt = (t) => (Array.isArray(params.enterThreshold) ? params.enterThreshold[t] : params.enterThreshold);

    for (let t = 0; t < n; t++) {
      balance += balance * monthlyRate;
      balance += deposit;

      const ratio = fairArr[t] / prices[t];
      const desired =
        ratio < thresholdAt(t) ? deposit * params.baseRate : deposit + params.reserveSpendFraction * balance;

      let m = desired / deposit;
      m = clamp(m, params.mMin, params.mMax);
      mult[t] = m;

      const clampedDesired = deposit * m;
      const spend = fundingMode === "unbound" ? clampedDesired : Math.min(clampedDesired, balance);
      balance -= spend;
    }

    return mult;
  }

  /* ---------------------------------------------------------------- *
   * Orchestration
   * ---------------------------------------------------------------- */

  // Builds the multiplier array for one strategy — power-law (a stateless
  // .map() over prices/fair) or threshold (its own stateful forward pass).
  // s: {strategyType, exponent, mMin, mMax, calibrate, targetDeployment,
  //     threshold: {enterThreshold, baseRate, reserveSpendFraction, useBand, bandSigma}}
  function buildStrategyMultipliers(fair, prices, deposit, s, fundingOpts) {
    if (s.strategyType === "threshold") {
      const t = s.threshold || {};
      let enterThreshold = t.enterThreshold == null ? 1.3 : t.enterThreshold;
      if (t.useBand) {
        const sigma = residualSigma(fair, prices);
        enterThreshold = Math.exp((t.bandSigma == null ? 1 : t.bandSigma) * sigma);
      }
      return computeThresholdMultiplierArray(
        prices,
        fair,
        deposit,
        {
          enterThreshold,
          baseRate: t.baseRate == null ? 0.6 : t.baseRate,
          reserveSpendFraction: t.reserveSpendFraction == null ? 0.25 : t.reserveSpendFraction,
          mMin: s.mMin,
          mMax: s.mMax,
        },
        fundingOpts
      );
    }
    const k = s.calibrate ? calibrationConstant(fair, prices, s.exponent, null, s.targetDeployment) : 1;
    return Float64Array.from(prices, (p, i) => clamp(k * Math.pow(fair[i] / p, s.exponent), s.mMin, s.mMax));
  }

  // If lumpSumAtStart, fundingOpts.startingCapital is spent immediately at
  // t=0 (folded straight into btc/invested, bypassing the reserve entirely)
  // instead of being held as an initial balance — "cash you hold today
  // either goes in now or waits," and lumpSumAtStart says which.
  function runWithLumpSum(prices, mult, deposit, fundingOpts, lumpSumAtStart) {
    fundingOpts = fundingOpts || {};
    if (!lumpSumAtStart || !fundingOpts.startingCapital) {
      return simulateLedger(prices, mult, deposit, fundingOpts);
    }
    const lumpBtc = fundingOpts.startingCapital / prices[0];
    const rest = simulateLedger(prices, mult, deposit, { ...fundingOpts, startingCapital: 0 });
    const finalPrice = prices[prices.length - 1];
    const btc = rest.btc + lumpBtc;
    return {
      ...rest,
      btc,
      invested: rest.invested + fundingOpts.startingCapital,
      btcValue: btc * finalPrice,
      totalValue: btc * finalPrice + rest.cashLeft,
      btcTrace: rest.btcTrace.map((b) => b + lumpBtc),
      lumpBtc,
    };
  }

  // cfg: {startDate, endDate, deposit, fitMode, calibrate,
  //       fundingMode, startingCapital, reserveRateAnnual,
  //       strategies: [{name, strategyType, exponent, mMin, mMax, targetDeployment,
  //                      lumpSumAtStart, threshold}]}
  function runBenchmarkSuite(cfg) {
    const dates = monthStarts(cfg.startDate, cfg.endDate);
    if (dates.length === 0) {
      throw new Error("Selected date range contains no month-start purchase dates.");
    }
    const prices = Float64Array.from(dates, closeOn);
    const fair = Float64Array.from(fairValueSeries(dates, cfg.fitMode));

    const fundingOpts = {
      fundingMode: cfg.fundingMode || "strict",
      startingCapital: cfg.startingCapital || 0,
      reserveRateAnnual: cfg.reserveRateAnnual || 0,
    };

    const ceiling = perfectTiming(prices, cfg.deposit, "best", fundingOpts.startingCapital);
    const floor = perfectTiming(prices, cfg.deposit, "worst", fundingOpts.startingCapital);

    const ones = new Float64Array(prices.length).fill(1);
    // DCA's fixed behaviour: a lump sum goes in immediately (see runWithLumpSum).
    const dca = runWithLumpSum(prices, ones, cfg.deposit, fundingOpts, true);

    const results = cfg.strategies.map((s) => {
      const stratSpec = { ...s, calibrate: cfg.calibrate };
      const mult = buildStrategyMultipliers(fair, prices, cfg.deposit, stratSpec, fundingOpts);
      const run = runWithLumpSum(prices, mult, cfg.deposit, fundingOpts, !!s.lumpSumAtStart);
      return {
        name: s.name,
        run,
        multipliers: mult,
        deltaVsDcaPct: 100 * (run.btc / dca.btc - 1),
        capture: captureRatio(run.btc, dca.btc, ceiling.btc),
        // Default significance test — valid for every strategy type,
        // threshold included (see signalPermutationTest).
        signalPermutation: signalPermutationTest(fair, prices, cfg.deposit, stratSpec, fundingOpts),
        // Legacy multiplier-permutation test, kept only for the
        // "legacy — invalid for threshold" UI toggle.
        permutation: permutationTest(prices, mult, cfg.deposit, undefined, undefined, fundingOpts),
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
      fundingMode: fundingOpts.fundingMode,
    };
  }

  global.Benchmarks = {
    simulateLedger,
    perfectTiming,
    captureRatio,
    permutationTest,
    signalPermutationTest,
    blockShuffle,
    mulberry32,
    clamp,
    monthStarts,
    closeOn,
    fairValueSeries,
    calibrationConstant,
    residualSigma,
    computeThresholdMultiplierArray,
    buildStrategyMultipliers,
    runWithLumpSum,
    runBenchmarkSuite,
  };
})(typeof window !== "undefined" ? window : globalThis);
