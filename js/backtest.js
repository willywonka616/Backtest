// Ledger simulation + metrics for the three DCA strategies.
// Depends on window.PowerLaw (js/powerlaw.js).
(function (global) {
  "use strict";

  const PL = global.PowerLaw;
  const MIN_POINTS = 1500;
  const CALIB_WINDOW_MONTHS = 48; // trailing 4 years

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  function parseISO(dateStr) {
    return PL.parseISODate(dateStr);
  }

  function yearOf(dateStr) {
    return Number(dateStr.slice(0, 4));
  }

  function addMonths(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const total = (m - 1) + n;
    const ny = y + Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12;
    return `${ny.toString().padStart(4, "0")}-${(nm + 1).toString().padStart(2, "0")}-01`;
  }

  // The first 1st-of-month date that is >= dateStr.
  function nextMonthStart(dateStr) {
    let cur = dateStr.slice(0, 8) + "01";
    if (cur < dateStr) cur = addMonths(cur, 1);
    return cur;
  }

  // First-of-month dates t with startDate <= t <= endDate.
  function monthStarts(startDate, endDate) {
    const out = [];
    let cur = nextMonthStart(startDate);
    while (cur <= endDate) {
      out.push(cur);
      cur = addMonths(cur, 1);
    }
    return out;
  }

  // Close price on dateStr, or the next available date if missing.
  // Returns { price, dateUsed } or null if the series has no data at or after dateStr.
  function closeOn(data, dateStr) {
    const startIdx = PL.daysBetween(data.startDate, dateStr);
    for (let idx = Math.max(0, startIdx); idx < data.closes.length; idx++) {
      const price = data.closes[idx];
      if (price != null && price > 0) {
        const used = PL.addDays(data.startDate, idx);
        return { price, dateUsed: used };
      }
    }
    return null;
  }

  // Validates the expanding-mode minimum-history requirement for a given
  // start date, throwing a descriptive error if it can't be satisfied.
  function assertExpandingHistorySufficient(data, startDate) {
    const firstPurchase = nextMonthStart(startDate);
    const idxBeforePurchase = PL.daysBetween(data.startDate, firstPurchase) - 1;
    const available = idxBeforePurchase + 1; // number of points strictly before firstPurchase
    if (available < MIN_POINTS) {
      const earliestOk = PL.addDays(data.startDate, MIN_POINTS);
      throw new Error(
        `Expanding fit mode needs at least ${MIN_POINTS} days of price history before the first ` +
          `purchase date. With start date ${startDate} only ${Math.max(available, 0)} days are ` +
          `available. Choose a start date on or after ${earliestOk}.`
      );
    }
  }

  // Builds the shared fair-value context reused across all three strategies
  // (and across every optimizer grid cell): the plFair series does not
  // depend on deposit, p, mMin, or mMax.
  //
  // Returns { purchaseDates, extendedDates, plFairByDate: Map<date, {plFair, fit}> }.
  function prepareFairValueContext(data, startDate, endDate, fitMode) {
    if (fitMode === "expanding") {
      assertExpandingHistorySufficient(data, startDate);
    }

    const purchaseDates = monthStarts(startDate, endDate);
    if (purchaseDates.length === 0) {
      throw new Error("Selected date range contains no month-start purchase dates.");
    }

    // Extend the fair-value series backward so the calibration window has
    // up to CALIB_WINDOW_MONTHS of pre-startDate history to draw on, honestly
    // bounded by how far back the expanding fit's minimum-history rule allows.
    let extendedStart = addMonths(purchaseDates[0], -CALIB_WINDOW_MONTHS);
    const earliestFeasible = PL.addDays(data.startDate, MIN_POINTS);
    if (extendedStart < earliestFeasible) extendedStart = nextMonthStart(earliestFeasible);
    if (extendedStart > purchaseDates[0]) extendedStart = purchaseDates[0];

    const extendedDates = monthStarts(extendedStart, endDate);
    const series = PL.computeFairValueSeries(data, extendedDates, fitMode, MIN_POINTS);

    const plFairByDate = new Map();
    for (const row of series) plFairByDate.set(row.date, row);

    return { purchaseDates, extendedDates, plFairByDate };
  }

  // k_year = targetDeployment / median( (plFair(tau)/price(tau))^p ) over a
  // trailing window of up to CALIB_WINDOW_MONTHS months strictly before
  // Jan 1 of `year`, drawn only from extendedDates (data available at that
  // time). targetDeployment (default 1) generalizes the old "median == 1"
  // identity to "median == targetDeployment" — how a reduced-deployment
  // strategy is expressed, with deposit held identical across strategies.
  // Ignored (k stays 1) at exponent 0, which is always the untouched DCA
  // baseline regardless of any other strategy's dial.
  //
  // Also returns sigmaMap: the same trailing window's residual stdev
  // (ln(price/plFair)) per year, for a threshold strategy's optional
  // "below -bandSigma sigma" deep-value definition — computed here rather
  // than in a fresh pass because it's the exact same window already being
  // walked for k.
  function computeKMap(data, context, p, calibrationOn, targetDeployment) {
    targetDeployment = targetDeployment == null ? 1 : targetDeployment;
    if (!calibrationOn) {
      const years = new Set(context.purchaseDates.map(yearOf));
      const kMap = new Map();
      const sigmaMap = new Map();
      for (const y of years) {
        kMap.set(y, 1);
        sigmaMap.set(y, 0);
      }
      return { kMap, kMin: 1, kMax: 1, sigmaMap };
    }

    const years = [...new Set(context.purchaseDates.map(yearOf))].sort((a, b) => a - b);
    const kMap = new Map();
    const sigmaMap = new Map();
    let kMin = Infinity;
    let kMax = -Infinity;

    for (const year of years) {
      const yearStart = `${year}-01-01`;
      const windowStart = addMonths(yearStart, -CALIB_WINDOW_MONTHS);
      const ratios = [];
      const residuals = [];
      for (const d of context.extendedDates) {
        if (d >= yearStart) break; // only data available before the recompute date
        if (d < windowStart) continue;
        const row = context.plFairByDate.get(d);
        const price = closeOn(data, d);
        if (!row || !price) continue;
        const ratio = row.plFair / price.price;
        ratios.push(Math.pow(ratio, p));
        residuals.push(Math.log(price.price / row.plFair));
      }
      const k = p === 0 ? 1 : ratios.length > 0 ? targetDeployment / median(ratios) : targetDeployment;
      kMap.set(year, k);
      sigmaMap.set(year, stdev(residuals));
    }

    // Track the k range actually applied to purchase months.
    for (const d of context.purchaseDates) {
      const k = kMap.get(yearOf(d));
      if (k < kMin) kMin = k;
      if (k > kMax) kMax = k;
    }
    if (kMin === Infinity) {
      kMin = targetDeployment;
      kMax = targetDeployment;
    }

    return { kMap, kMin, kMax, sigmaMap };
  }

  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return NaN;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function stdev(arr) {
    const n = arr.length;
    if (n === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  }

  // Computes the per-month multiplier decision for one strategy: the price,
  // power-law fair value, raw ratio, calibration k, and clamped multiplier
  // at every purchase date. Split out from runLedger so the actual money
  // arithmetic (spend/balance/btc) has exactly one implementation, shared
  // with the benchmark suite and the rolling-window study — see
  // Benchmarks.simulateLedger in js/benchmarks.js.
  // params: { p, mMin, mMax, deposit, targetDeployment, strategyType,
  //           threshold: {enterThreshold, baseRate, reserveSpendFraction, useBand, bandSigma} }
  // fundingOpts (only consulted for a threshold strategy's own forward pass —
  // see Benchmarks.computeThresholdMultiplierArray): { fundingMode, startingCapital, reserveRateAnnual }
  function computeMultiplierSeries(data, context, params, calibrationOn, fundingOpts) {
    fundingOpts = fundingOpts || {};
    const { p, mMin, mMax, targetDeployment } = params;
    const { kMap, kMin, kMax, sigmaMap } = computeKMap(data, context, p, calibrationOn, targetDeployment);

    const n = context.purchaseDates.length;
    const prices = new Float64Array(n);
    const priceDatesUsed = new Array(n);
    const plFairArr = new Float64Array(n);
    const mRawArr = new Float64Array(n);
    const kArr = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const t = context.purchaseDates[i];
      const priceInfo = closeOn(data, t);
      if (!priceInfo) throw new Error(`No price data available on or after ${t}`);
      const price = priceInfo.price;

      const fairRow = context.plFairByDate.get(t);
      if (!fairRow) throw new Error(`No power-law fair value computed for ${t}`);
      const plFair = fairRow.plFair;

      const mRaw = p === 0 ? 1 : Math.pow(plFair / price, p);
      const k = kMap.get(yearOf(t));

      prices[i] = price;
      priceDatesUsed[i] = priceInfo.dateUsed;
      plFairArr[i] = plFair;
      mRawArr[i] = mRaw;
      kArr[i] = k;
    }

    let multipliers;
    if (params.strategyType === "threshold") {
      // Stateful, balance-dependent rule — can't be a stateless .map() like
      // the power-law formula, so it gets its own forward pass (mirroring
      // simulateLedger's exact balance mechanics) that yields a concrete
      // realized multiplier array. From that point on it flows through
      // runLedger/simulateLedger/permutationTest exactly like a power-law
      // strategy — see Benchmarks.computeThresholdMultiplierArray.
      const th = params.threshold || {};
      let enterThreshold = th.enterThreshold == null ? 1.3 : th.enterThreshold;
      if (th.useBand) {
        // No-lookahead residual band: each month's threshold uses that
        // year's trailing sigma (computed alongside k in computeKMap), not a
        // single whole-sample sigma.
        const bandSigma = th.bandSigma == null ? 1 : th.bandSigma;
        enterThreshold = context.purchaseDates.map((t) => Math.exp(bandSigma * (sigmaMap.get(yearOf(t)) || 0)));
      }
      multipliers = global.Benchmarks.computeThresholdMultiplierArray(
        prices,
        plFairArr,
        params.deposit,
        {
          enterThreshold,
          baseRate: th.baseRate == null ? 0.6 : th.baseRate,
          reserveSpendFraction: th.reserveSpendFraction == null ? 0.25 : th.reserveSpendFraction,
          mMin,
          mMax,
        },
        fundingOpts
      );
    } else {
      multipliers = new Float64Array(n);
      for (let i = 0; i < n; i++) multipliers[i] = clamp(kArr[i] * mRawArr[i], mMin, mMax);
    }

    return { prices, priceDatesUsed, plFairArr, mRawArr, kArr, multipliers, kMin, kMax };
  }

  // Runs the per-month ledger loop for one strategy.
  // params: { p, mMin, mMax, deposit, targetDeployment, strategyType, threshold,
  //           fundingMode, startingCapital, reserveRateAnnual, lumpSumAtStart }
  // Returns { trace, kMin, kMax, result, fundingOpts, lumpSumAtStart }, where
  // `result` is the raw ledger result (see Benchmarks.simulateLedger /
  // runWithLumpSum) — computeMetrics uses it directly for invested/btc/
  // cashLeft/totalValue so a lump-sum startingCapital (folded in at t=0,
  // outside the per-month trace) is still counted correctly.
  function runLedger(data, context, params, calibrationOn) {
    const fundingOpts = {
      fundingMode: params.fundingMode || "strict",
      startingCapital: params.startingCapital || 0,
      reserveRateAnnual: params.reserveRateAnnual || 0,
    };
    const series = computeMultiplierSeries(data, context, params, calibrationOn, fundingOpts);
    const lumpSumAtStart = !!params.lumpSumAtStart;
    const result = global.Benchmarks.runWithLumpSum(
      series.prices,
      series.multipliers,
      params.deposit,
      fundingOpts,
      lumpSumAtStart
    );

    const trace = context.purchaseDates.map((t, i) => ({
      date: t,
      priceDateUsed: series.priceDatesUsed[i],
      price: series.prices[i],
      plFair: series.plFairArr[i],
      mRaw: series.mRawArr[i],
      k: series.kArr[i],
      m: series.multipliers[i],
      desired: params.deposit * series.multipliers[i],
      spend: result.spendTrace[i],
      balance: result.balanceTrace[i],
      btc: result.btcTrace[i],
      portfolioValue: result.btcTrace[i] * series.prices[i] + result.balanceTrace[i],
      starved: result.starvedTrace[i] === 1,
    }));

    return { trace, kMin: series.kMin, kMax: series.kMax, result, fundingOpts, lumpSumAtStart };
  }

  // Builds one strategy's multiplier array over a SINGLE self-contained
  // window (handles both 'power' and 'threshold' strategyType alike) and
  // runs it through the shared ledger. This is the calibration scheme
  // rollingWindowStudy and runBenchmarkSuite both need: a scalar k (or, for
  // threshold, a numeric/band enterThreshold) computed from exactly the
  // window passed in, with no "future" data outside it to guard against —
  // unlike runLedger above, whose annual trailing no-lookahead calibration
  // only makes sense across one continuous historical run, not a detached
  // window. See Benchmarks.calibrationConstant's own comment for why the two
  // schemes are deliberately different, not a bug to unify.
  //
  // Delegates multiplier construction to Benchmarks.buildStrategyMultipliers
  // (the one place implementing both the power-law formula and the
  // threshold strategy's own stateful forward pass), so every caller that
  // operates on one closed window — rolling.js and benchmarks.js's
  // runBenchmarkSuite — shares this exact code path instead of each keeping
  // its own copy. rolling.js used to keep an inline power-formula-only copy
  // that silently produced nonsense (or NaN) for a threshold strategy;
  // routing it through here is what fixes that.
  //
  // prices, fair: Float64Array, parallel, one purchase-date window.
  // dates: the window's purchase dates (ISO strings) — the self-contained
  // calibration below doesn't consult them itself (there's no "future" to
  // guard against within one closed window); accepted for parity with the
  // other multiplier-series builders and so callers already holding a dates
  // slice don't need to discard it to call this.
  // strategyCfg: {strategyType, exponent, mMin, mMax, calibrate,
  //               targetDeployment, threshold: {...}, lumpSumAtStart}
  // fundingOpts: {fundingMode, startingCapital, reserveRateAnnual}
  //
  // Returns {multipliers, result} where result is the raw ledger result
  // (Benchmarks.simulateLedger, run via runWithLumpSum so lumpSumAtStart is
  // honored exactly as it is for the main backtest).
  function runStrategy(prices, fair, dates, strategyCfg, deposit, fundingOpts) {
    fundingOpts = fundingOpts || {};
    const multipliers = global.Benchmarks.buildStrategyMultipliers(fair, prices, deposit, strategyCfg, fundingOpts);
    const result = global.Benchmarks.runWithLumpSum(prices, multipliers, deposit, fundingOpts, !!strategyCfg.lumpSumAtStart);
    return { multipliers, result };
  }

  // ---- Metrics ----------------------------------------------------------

  // opts.startingCapital: committed at t0 for every strategy alike (default 0).
  // opts.ledgerResult: the raw result from runLedger (Benchmarks.simulateLedger /
  //   runWithLumpSum). When given, invested/btc/cashLeft/totalValue come from it
  //   directly rather than being re-summed from trace, which matters for a
  //   lump-sum startingCapital: it's folded into btc/invested at t=0, outside
  //   any month's per-month spend, so re-summing trace.spend would silently
  //   drop it. Omit for the old trace-only behavior (still correct when there
  //   is no startingCapital).
  function computeMetrics(data, trace, deposit, endDate, opts) {
    opts = opts || {};
    const startingCapital = opts.startingCapital || 0;
    const ledgerResult = opts.ledgerResult;
    const finalPrice = closeOn(data, endDate).price;
    const months = trace.length;
    const deposited = deposit * months;
    const totalCommitted = startingCapital + deposited;
    const invested = ledgerResult ? ledgerResult.invested : sum(trace.map((r) => r.spend));
    const cashLeft = ledgerResult ? ledgerResult.cashLeft : trace.length ? trace[trace.length - 1].balance : 0;
    const btc = ledgerResult ? ledgerResult.btc : trace.length ? trace[trace.length - 1].btc : 0;
    const btcValue = btc * finalPrice;
    const totalValue = ledgerResult ? ledgerResult.totalValue : btcValue + cashLeft;
    const starvedMonths = trace.filter((r) => r.starved).length;
    const unmetDemand = sum(trace.map((r) => Math.max(0, r.desired - r.spend)));
    const balances = trace.map((r) => r.balance);

    // startingCapital is a t0 outflow for every strategy alike, whether it's
    // deployed immediately (lumpSumAtStart) or held as reserve — the investor
    // committed it at t0 either way; only when the strategy chose to spend it
    // differs.
    const cashFlows = trace.map((r, i) => ({
      date: r.date,
      amount: i === 0 ? -(deposit + startingCapital) : -deposit,
    }));
    cashFlows.push({ date: endDate, amount: totalValue });
    const xirr = computeXIRR(cashFlows);

    return {
      deposited,
      totalCommitted,
      invested,
      deploymentRate: deposited > 0 ? invested / deposited : null,
      cashLeft,
      btcAccumulated: btc,
      avgCostBasis: btc > 0 ? invested / btc : null,
      btcValue,
      totalValue,
      moicOnInvested: invested > 0 ? totalValue / invested : null,
      moicOnDeposited: deposited > 0 ? totalValue / deposited : null,
      moicOnCommitted: totalCommitted > 0 ? totalValue / totalCommitted : null,
      xirr,
      starvedMonths,
      starvedMonthsPct: months ? starvedMonths / months : 0,
      unmetDemand,
      unmetDemandPct: deposited > 0 ? unmetDemand / deposited : 0,
      reserveMax: balances.length ? Math.max(...balances) : 0,
      reserveMean: balances.length ? sum(balances) / balances.length : 0,
      reserveMonthsAtZero: balances.filter((b) => b < 0.005).length,
    };
  }

  function sum(arr) {
    let s = 0;
    for (const x of arr) s += x;
    return s;
  }

  function compareToBaseline(metrics, baseline) {
    const deltaBtcPct =
      baseline.btcAccumulated > 0
        ? (metrics.btcAccumulated - baseline.btcAccumulated) / baseline.btcAccumulated
        : null;
    const deltaTotalValue = metrics.totalValue - baseline.totalValue;
    const deltaTotalValuePct =
      baseline.totalValue > 0 ? deltaTotalValue / baseline.totalValue : null;
    const deltaXirrPts =
      metrics.xirr != null && baseline.xirr != null ? metrics.xirr - baseline.xirr : null;
    return { deltaBtcPct, deltaTotalValue, deltaTotalValuePct, deltaXirrPts };
  }

  // ---- XIRR ---------------------------------------------------------------
  // Newton's method with a bisection fallback, bracket [-0.99, 10].
  // Returns annualized rate as a decimal (0.1 == 10%), or null if it fails
  // to converge.
  function computeXIRR(cashFlows) {
    if (cashFlows.length < 2) return null;
    const t0 = parseISO(cashFlows[0].date).getTime();
    const yearsFrac = cashFlows.map(
      (cf) => (parseISO(cf.date).getTime() - t0) / (365 * 86400000)
    );
    const amounts = cashFlows.map((cf) => cf.amount);

    const hasNeg = amounts.some((a) => a < 0);
    const hasPos = amounts.some((a) => a > 0);
    if (!hasNeg || !hasPos) return null;

    function npv(rate) {
      let s = 0;
      for (let i = 0; i < amounts.length; i++) {
        s += amounts[i] / Math.pow(1 + rate, yearsFrac[i]);
      }
      return s;
    }
    function dnpv(rate) {
      let s = 0;
      for (let i = 0; i < amounts.length; i++) {
        if (yearsFrac[i] === 0) continue;
        s += (-yearsFrac[i] * amounts[i]) / Math.pow(1 + rate, yearsFrac[i] + 1);
      }
      return s;
    }

    // Newton's method.
    let rate = 0.1;
    let converged = false;
    for (let i = 0; i < 100; i++) {
      const f = npv(rate);
      const df = dnpv(rate);
      if (Math.abs(f) < 1e-6) {
        converged = true;
        break;
      }
      if (df === 0 || !Number.isFinite(df)) break;
      let next = rate - f / df;
      if (!Number.isFinite(next) || next <= -0.99 || next > 100) break;
      rate = next;
    }
    if (converged && rate > -0.99 && rate < 100) return rate;

    // Bisection fallback on [-0.99, 10].
    let lo = -0.99;
    let hi = 10;
    let fLo = npv(lo);
    let fHi = npv(hi);
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const fMid = npv(mid);
      if (Math.abs(fMid) < 1e-6) return mid;
      if (fLo * fMid < 0) {
        hi = mid;
        fHi = fMid;
      } else {
        lo = mid;
        fLo = fMid;
      }
    }
    return (lo + hi) / 2;
  }

  global.Backtest = {
    MIN_POINTS,
    CALIB_WINDOW_MONTHS,
    clamp,
    monthStarts,
    nextMonthStart,
    addMonths,
    closeOn,
    assertExpandingHistorySufficient,
    prepareFairValueContext,
    computeKMap,
    computeMultiplierSeries,
    runLedger,
    runStrategy,
    computeMetrics,
    compareToBaseline,
    computeXIRR,
    median,
  };
})(typeof window !== "undefined" ? window : globalThis);
