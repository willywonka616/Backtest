// Grid search over (mMin, mMax) for a fixed exponent p.
// Depends on window.PowerLaw and window.Backtest. Safe to run either on the
// main thread (chunked, see app.js) or inside a Web Worker via importScripts.
(function (global) {
  "use strict";

  const B = global.Backtest;
  const PL = global.PowerLaw;

  const MMIN_STEP = 0.05;
  const MMIN_MAX = 1.0;
  const MMAX_STEP = 0.25;
  const MMAX_MIN = 1.0;
  const MMAX_MAX = 8.0;

  const ROBUSTNESS_PERIODS = [
    { label: "2018-01 to 2021-12", start: "2018-01-01", end: "2021-12-01" },
    { label: "2021-01 to 2024-12", start: "2021-01-01", end: "2024-12-01" },
    { label: "2022-01 to present", start: "2022-01-01", end: null }, // end resolved to data's last date
  ];

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  // All {mMin, mMax} grid cells, mMin > mMax combinations skipped.
  function generateGrid() {
    const cells = [];
    const nMin = Math.round(MMIN_MAX / MMIN_STEP);
    const nMax = Math.round((MMAX_MAX - MMAX_MIN) / MMAX_STEP);
    for (let i = 0; i <= nMin; i++) {
      const mMin = round2(i * MMIN_STEP);
      for (let j = 0; j <= nMax; j++) {
        const mMax = round2(MMAX_MIN + j * MMAX_STEP);
        if (mMin > mMax) continue;
        cells.push({ mMin, mMax });
      }
    }
    return cells;
  }

  function objectiveValue(metrics, objective) {
    if (objective === "totalValue") return metrics.totalValue;
    if (objective === "xirr") return metrics.xirr;
    return metrics.btcAccumulated; // default
  }

  // opts: { p, startDate, endDate, deposit, fitMode, calibrationOn, objective,
  //         targetDeployment, fundingMode, startingCapital, reserveRateAnnual, lumpSumAtStart }
  // The optimizer never runs under fundingMode 'unbound' — that mode is a
  // diagnostic (borrowing against a negative balance), not a runnable
  // strategy, so a search over it would rank parameter sets by how much debt
  // they're willing to take on. See runSweep's guard.
  function evaluateCell(data, context, opts, mMin, mMax) {
    const params = {
      p: opts.p,
      mMin,
      mMax,
      deposit: opts.deposit,
      targetDeployment: opts.targetDeployment,
      fundingMode: opts.fundingMode,
      startingCapital: opts.startingCapital,
      reserveRateAnnual: opts.reserveRateAnnual,
      lumpSumAtStart: opts.lumpSumAtStart,
    };
    const { trace, result } = B.runLedger(data, context, params, opts.calibrationOn);
    const metrics = B.computeMetrics(data, trace, opts.deposit, opts.endDate, {
      ledgerResult: result,
      startingCapital: opts.startingCapital || 0,
    });
    return { mMin, mMax, metrics, objectiveValue: objectiveValue(metrics, opts.objective) };
  }

  function computeBaseline(data, context, opts) {
    const params = {
      p: 0,
      mMin: 0,
      mMax: 1,
      deposit: opts.deposit,
      fundingMode: opts.fundingMode,
      startingCapital: opts.startingCapital,
      reserveRateAnnual: opts.reserveRateAnnual,
      lumpSumAtStart: true, // DCA always deploys any starting capital immediately
    };
    const { trace, result } = B.runLedger(data, context, params, opts.calibrationOn);
    return B.computeMetrics(data, trace, opts.deposit, opts.endDate, {
      ledgerResult: result,
      startingCapital: opts.startingCapital || 0,
    });
  }

  // Synchronous full sweep. onProgress(done, total) is called after every cell,
  // cheap enough (~600 cells) to not need throttling.
  function runSweep(data, opts, onProgress) {
    if (opts.fundingMode === "unbound") {
      throw new Error(
        "The optimizer does not run under unbound funding — it is a diagnostic mode (negative balances, i.e. " +
          "borrowing) that would rank boundaries by how much debt they're willing to take on, not by timing skill. " +
          "Switch funding mode to strict or seeded first."
      );
    }
    const context = B.prepareFairValueContext(data, opts.startDate, opts.endDate, opts.fitMode);
    const baseline = computeBaseline(data, context, opts);
    const grid = generateGrid();
    const cells = [];

    for (let i = 0; i < grid.length; i++) {
      const { mMin, mMax } = grid[i];
      cells.push(evaluateCell(data, context, opts, mMin, mMax));
      if (onProgress) onProgress(i + 1, grid.length);
    }

    const ranked = [...cells]
      .filter((c) => c.objectiveValue != null && Number.isFinite(c.objectiveValue))
      .sort((a, b) => b.objectiveValue - a.objectiveValue);
    const top10 = ranked.slice(0, 10);

    let robustness = null;
    if (top10.length > 0) {
      robustness = runRobustness(data, opts, top10[0].mMin, top10[0].mMax);
    }

    return { baseline, cells, top10, robustness };
  }

  // Reruns a chosen (mMin, mMax) on fixed sub-periods, each compared to its
  // own DCA baseline computed on the same sub-period.
  function runRobustness(data, opts, mMin, mMax) {
    const dataEnd = PL.addDays(data.startDate, data.closes.length - 1);

    return ROBUSTNESS_PERIODS.map((period) => {
      const start = period.start;
      const end = period.end || dataEnd;
      if (end <= start) {
        return { label: period.label, start, end, available: false, reason: "No overlap with available data." };
      }
      try {
        const subOpts = { ...opts, startDate: start, endDate: end };
        const context = B.prepareFairValueContext(data, start, end, opts.fitMode);
        const baseline = computeBaseline(data, context, subOpts);
        const result = evaluateCell(data, context, subOpts, mMin, mMax);
        const cmp = B.compareToBaseline(result.metrics, baseline);
        return {
          label: period.label,
          start,
          end,
          available: true,
          beatsBaseline: cmp.deltaBtcPct != null && cmp.deltaBtcPct > 0,
          metrics: result.metrics,
          baseline,
          comparison: cmp,
        };
      } catch (err) {
        return { label: period.label, start, end, available: false, reason: err.message };
      }
    });
  }

  global.Optimizer = {
    MMIN_STEP,
    MMIN_MAX,
    MMAX_STEP,
    MMAX_MIN,
    MMAX_MAX,
    ROBUSTNESS_PERIODS,
    generateGrid,
    evaluateCell,
    computeBaseline,
    runSweep,
    runRobustness,
    objectiveValue,
  };
})(typeof window !== "undefined" ? window : globalThis);
