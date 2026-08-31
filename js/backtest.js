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

  // k_year = 1 / median( (plFair(tau)/price(tau))^p ) over a trailing window
  // of up to CALIB_WINDOW_MONTHS months strictly before Jan 1 of `year`,
  // drawn only from extendedDates (data available at that time).
  function computeKMap(data, context, p, calibrationOn) {
    if (!calibrationOn) {
      const years = new Set(context.purchaseDates.map(yearOf));
      const kMap = new Map();
      for (const y of years) kMap.set(y, 1);
      return { kMap, kMin: 1, kMax: 1 };
    }

    const years = [...new Set(context.purchaseDates.map(yearOf))].sort((a, b) => a - b);
    const kMap = new Map();
    let kMin = Infinity;
    let kMax = -Infinity;

    for (const year of years) {
      const yearStart = `${year}-01-01`;
      const windowStart = addMonths(yearStart, -CALIB_WINDOW_MONTHS);
      const ratios = [];
      for (const d of context.extendedDates) {
        if (d >= yearStart) break; // only data available before the recompute date
        if (d < windowStart) continue;
        const row = context.plFairByDate.get(d);
        const price = closeOn(data, d);
        if (!row || !price) continue;
        const ratio = row.plFair / price.price;
        ratios.push(Math.pow(ratio, p));
      }
      const k = ratios.length > 0 ? 1 / median(ratios) : 1;
      kMap.set(year, k);
    }

    // Track the k range actually applied to purchase months.
    for (const d of context.purchaseDates) {
      const k = kMap.get(yearOf(d));
      if (k < kMin) kMin = k;
      if (k > kMax) kMax = k;
    }
    if (kMin === Infinity) {
      kMin = 1;
      kMax = 1;
    }

    return { kMap, kMin, kMax };
  }

  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return NaN;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  // Computes the per-month multiplier decision for one strategy: the price,
  // power-law fair value, raw ratio, calibration k, and clamped multiplier
  // at every purchase date. Split out from runLedger so the actual money
  // arithmetic (spend/balance/btc) has exactly one implementation, shared
  // with the benchmark suite and the rolling-window study — see
  // Benchmarks.simulateLedger in js/benchmarks.js.
  function computeMultiplierSeries(data, context, params, calibrationOn) {
    const { p, mMin, mMax } = params;
    const { kMap, kMin, kMax } = computeKMap(data, context, p, calibrationOn);

    const n = context.purchaseDates.length;
    const prices = new Float64Array(n);
    const priceDatesUsed = new Array(n);
    const plFairArr = new Float64Array(n);
    const mRawArr = new Float64Array(n);
    const kArr = new Float64Array(n);
    const multipliers = new Float64Array(n);

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
      const m = clamp(k * mRaw, mMin, mMax);

      prices[i] = price;
      priceDatesUsed[i] = priceInfo.dateUsed;
      plFairArr[i] = plFair;
      mRawArr[i] = mRaw;
      kArr[i] = k;
      multipliers[i] = m;
    }

    return { prices, priceDatesUsed, plFairArr, mRawArr, kArr, multipliers, kMin, kMax };
  }

  // Runs the per-month ledger loop for one strategy.
  // params: { p, mMin, mMax, deposit, startingBalance }
  // Returns { trace, kMin, kMax }.
  function runLedger(data, context, params, calibrationOn) {
    const series = computeMultiplierSeries(data, context, params, calibrationOn);
    const result = global.Benchmarks.simulateLedger(series.prices, series.multipliers, params.deposit, {
      startingBalance: params.startingBalance || 0,
    });

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

    return { trace, kMin: series.kMin, kMax: series.kMax };
  }

  // ---- Metrics ----------------------------------------------------------

  function computeMetrics(data, trace, deposit, endDate) {
    const finalPrice = closeOn(data, endDate).price;
    const deposited = deposit * trace.length;
    const invested = sum(trace.map((r) => r.spend));
    const cashLeft = trace.length ? trace[trace.length - 1].balance : 0;
    const btc = trace.length ? trace[trace.length - 1].btc : 0;
    const btcValue = btc * finalPrice;
    const totalValue = btcValue + cashLeft;
    const starvedMonths = trace.filter((r) => r.starved).length;
    const unmetDemand = sum(trace.map((r) => Math.max(0, r.desired - r.spend)));
    const balances = trace.map((r) => r.balance);

    const cashFlows = trace.map((r) => ({ date: r.date, amount: -deposit }));
    cashFlows.push({ date: endDate, amount: totalValue });
    const xirr = computeXIRR(cashFlows);

    return {
      deposited,
      invested,
      deploymentRate: deposited > 0 ? invested / deposited : null,
      cashLeft,
      btcAccumulated: btc,
      avgCostBasis: btc > 0 ? invested / btc : null,
      btcValue,
      totalValue,
      moicOnInvested: invested > 0 ? totalValue / invested : null,
      moicOnDeposited: deposited > 0 ? totalValue / deposited : null,
      xirr,
      starvedMonths,
      starvedMonthsPct: trace.length ? starvedMonths / trace.length : 0,
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
    runLedger,
    computeMetrics,
    compareToBaseline,
    computeXIRR,
    median,
  };
})(typeof window !== "undefined" ? window : globalThis);
