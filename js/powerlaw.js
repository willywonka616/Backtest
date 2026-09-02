// Power-law fit: price = A * d^n, where d = days since the genesis block (2009-01-03).
// Fit by OLS on ln(price) = ln(A) + n * ln(d).
(function (global) {
  "use strict";

  const GENESIS_DATE = "2009-01-03";

  function parseISODate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function daysBetween(fromDateStr, toDateStr) {
    const msPerDay = 86400000;
    return Math.round(
      (parseISODate(toDateStr).getTime() - parseISODate(fromDateStr).getTime()) / msPerDay
    );
  }

  function addDays(dateStr, n) {
    const d = parseISODate(dateStr);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Days-since-genesis for a given calendar date string.
  function daysSinceGenesis(dateStr) {
    return daysBetween(GENESIS_DATE, dateStr);
  }

  // Incremental OLS accumulator on (ln(d), ln(price)) pairs.
  // Supports adding points one at a time so an "expanding" fit can be
  // refit at O(days added) rather than O(n) per refit.
  class RunningOLS {
    constructor() {
      this.n = 0;
      this.sx = 0;
      this.sy = 0;
      this.sxx = 0;
      this.sxy = 0;
      this.syy = 0;
    }

    add(x, y) {
      this.n++;
      this.sx += x;
      this.sy += y;
      this.sxx += x * x;
      this.sxy += x * y;
      this.syy += y * y;
    }

    // Returns { A, n: slope, r2, nPoints } or null if underdetermined.
    solve() {
      const N = this.n;
      if (N < 2) return null;
      const denom = N * this.sxx - this.sx * this.sx;
      if (denom === 0) return null;
      const slope = (N * this.sxy - this.sx * this.sy) / denom;
      const intercept = (this.sy - slope * this.sx) / N;

      // r^2 from sums of squares.
      const ssTot = this.syy - (this.sy * this.sy) / N;
      const ssRes = this.syy - intercept * this.sy - slope * this.sxy;
      const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

      return {
        A: Math.exp(intercept),
        n: slope,
        r2,
        nPoints: N,
      };
    }
  }

  // Fits price = A * d^n over daily closes from `data` (BTC_DATA shape)
  // for the inclusive date range [fitStartDate, fitEndDate].
  // Returns { A, n, r2, fitStart, fitEnd, nPoints }.
  function fitPowerLaw(data, fitStartDate, fitEndDate) {
    const ols = new RunningOLS();
    const startIdx = daysBetween(data.startDate, fitStartDate);
    const endIdx = daysBetween(data.startDate, fitEndDate);
    const clampedStart = Math.max(0, startIdx);
    const clampedEnd = Math.min(data.closes.length - 1, endIdx);

    for (let i = clampedStart; i <= clampedEnd; i++) {
      const dateStr = addDays(data.startDate, i);
      const d = daysSinceGenesis(dateStr);
      if (d <= 0) continue;
      const price = data.closes[i];
      if (!(price > 0)) continue;
      ols.add(Math.log(d), Math.log(price));
    }

    const fit = ols.solve();
    if (!fit) return null;

    return {
      A: fit.A,
      n: fit.n,
      r2: fit.r2,
      fitStart: fitStartDate,
      fitEnd: fitEndDate,
      nPoints: fit.nPoints,
    };
  }

  // Fair value at a given date from a resolved {A, n} fit.
  function fairValue(fit, dateStr) {
    const d = daysSinceGenesis(dateStr);
    return fit.A * Math.pow(d, fit.n);
  }

  // Precomputes a fair-value series for every purchase date in `purchaseDates`.
  //
  // mode "full": one fit over the entire available series, applied to every date.
  // mode "expanding": at each purchase date t, refit using only data strictly
  //   before t (data.startDate .. t - 1 day). Requires >= minPoints observations
  //   before the first purchase date; throws otherwise.
  //
  // Returns an array parallel to purchaseDates of
  // { date, plFair, fit: {A, n, r2, fitStart, fitEnd, nPoints} }.
  function computeFairValueSeries(data, purchaseDates, mode, minPoints) {
    minPoints = minPoints || 1500;

    if (mode === "full") {
      const fitEnd = addDays(data.startDate, data.closes.length - 1);
      const fit = fitPowerLaw(data, data.startDate, fitEnd);
      if (!fit) throw new Error("Power-law fit failed: insufficient data");
      return purchaseDates.map((date) => ({
        date,
        plFair: fairValue(fit, date),
        fit,
      }));
    }

    if (mode === "expanding") {
      const ols = new RunningOLS();
      let cursorIdx = -1; // last index (into data.closes) already added to ols

      const results = [];
      for (const date of purchaseDates) {
        const cutoffDateExclusive = date; // fit uses data strictly before this date
        const targetIdx = daysBetween(data.startDate, cutoffDateExclusive) - 1; // last index to include
        const clampedTarget = Math.min(targetIdx, data.closes.length - 1);

        while (cursorIdx < clampedTarget) {
          cursorIdx++;
          const dStr = addDays(data.startDate, cursorIdx);
          const d = daysSinceGenesis(dStr);
          const price = data.closes[cursorIdx];
          if (d > 0 && price > 0) {
            ols.add(Math.log(d), Math.log(price));
          }
        }

        if (ols.n < minPoints) {
          throw new Error(
            `Expanding fit requires >= ${minPoints} data points before the first purchase date; ` +
              `only ${ols.n} available before ${date}. Choose a later start date.`
          );
        }

        const solved = ols.solve();
        const fitEndDate = addDays(data.startDate, clampedTarget);
        const fit = {
          A: solved.A,
          n: solved.n,
          r2: solved.r2,
          fitStart: data.startDate,
          fitEnd: fitEndDate,
          nPoints: solved.n,
        };

        results.push({
          date,
          plFair: fairValue(fit, date),
          fit,
        });
      }
      return results;
    }

    throw new Error(`Unknown fit mode: ${mode}`);
  }

  global.PowerLaw = {
    GENESIS_DATE,
    daysSinceGenesis,
    daysBetween,
    addDays,
    parseISODate,
    RunningOLS,
    fitPowerLaw,
    fairValue,
    computeFairValueSeries,
  };
})(typeof window !== "undefined" ? window : globalThis);
