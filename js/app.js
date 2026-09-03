// Wiring: state, controls, rendering, URL hash persistence.
(function () {
  "use strict";

  const PL = window.PowerLaw;
  const B = window.Backtest;
  const DATA = window.BTC_DATA;

  const COLOR = { dca: "#7a8ba6", linear: "#f7931a", squared: "#4fb3a9", threshold: "#c77dff" };

  // ---------------------------------------------------------------------
  // Date helpers (strict DD.MM.YYYY <-> ISO)
  // ---------------------------------------------------------------------

  function formatDMY(iso) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  // Strict parse: rejects malformed strings and calendar-invalid dates
  // (e.g. 31.02.2020). Returns ISO "YYYY-MM-DD" or null.
  function parseDMY(str) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((str || "").trim());
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12) return null;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) return null;
    if (year < 2000 || year > 2100) return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function dataStartDate() {
    return DATA.startDate;
  }
  function dataEndDate() {
    return PL.addDays(DATA.startDate, DATA.closes.length - 1);
  }

  // ---------------------------------------------------------------------
  // Formatting (Swiss thousands separator)
  // ---------------------------------------------------------------------

  function fmtNum(x, decimals) {
    if (x == null || !Number.isFinite(x)) return "—";
    decimals = decimals == null ? 2 : decimals;
    const neg = x < 0;
    const fixed = Math.abs(x).toFixed(decimals);
    const [intPart, fracPart] = fixed.split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    return (neg ? "-" : "") + grouped + (fracPart != null ? "." + fracPart : "");
  }
  function fmtUsd(x) {
    return x == null || !Number.isFinite(x) ? "—" : "$" + fmtNum(x, 2);
  }
  function fmtBtc(x) {
    return x == null || !Number.isFinite(x) ? "—" : fmtNum(x, 6);
  }
  function fmtPct(x, decimals) {
    return x == null || !Number.isFinite(x) ? "—" : fmtNum(x * 100, decimals == null ? 2 : decimals) + "%";
  }
  function fmtX(x) {
    return x == null || !Number.isFinite(x) ? "—" : fmtNum(x, 3) + "×";
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  function defaultState() {
    return {
      startDate: "2018-01-01",
      endDate: dataEndDate(),
      fitMode: "expanding",
      calibration: true,
      // Funding mode + fair-comparison controls: startingCapital and
      // reserveRateAnnual are GLOBAL — applied identically to every
      // strategy, DCA included — so a comparison is never accidentally
      // stacking "more capital" on top of "better timing." Only
      // lumpSumAtStart (per strategy, below) controls whether each
      // strategy's share of it is deployed immediately or held as reserve.
      fundingMode: "strict",
      startingCapital: 0,
      reserveRateAnnual: 0, // percent, e.g. 2 == 2%/yr
      deposit: { dca: 500, linear: 500, squared: 500, threshold: 500 },
      bounds: {
        linear: { mMin: 0.0, mMax: 3.0 },
        squared: { mMin: 0.0, mMax: 3.0 },
        threshold: { mMin: 0.0, mMax: 3.0 },
      },
      // Reduced deployment is expressed as a target ratio the calibration
      // constant is solved for (k = targetDeployment / median(rawRatio)),
      // never as a smaller deposit — the deposit stays identical across
      // strategies so the comparison stays a timing comparison, not a
      // savings-rate one. DCA's own p=0 ignores this by construction.
      targetDeployment: { linear: 1.0, squared: 1.0 },
      // DCA deploys any starting capital immediately by default (that's
      // what "just DCA it all in" means); the power-law strategies hold it
      // as reserve by default, since the whole point of those strategies is
      // choosing *when* to deploy.
      lumpSumAtStart: { dca: true, linear: false, squared: false, threshold: false },
      // Threshold reserve strategy — present but OFF by default. Below
      // enterThreshold it buys a slow baseRate share of deposit (building
      // reserve); at/above it, it buys deposit plus a reserveSpendFraction
      // slice of whatever reserve has built up.
      threshold: {
        enabled: false,
        enterThreshold: 1.3,
        baseRate: 0.6,
        reserveSpendFraction: 0.25,
        useBand: false,
        bandSigma: 1,
      },
      optimizer: { strategy: "linear", objective: "btcAccumulated", targetDeployment: 1.0 },
    };
  }

  let state = defaultState();
  let lastResults = null; // populated by recompute()
  let priceChartInstance = null;
  let valueChartInstance = null;
  let reserveChartInstance = null;
  let multiplierChartInstance = null;

  // Populated by their respective run*() functions; consumed by the
  // mobile copy-to-clipboard summaries and window.summary() so those never
  // have to re-run anything, just format what's already on screen.
  let lastDataCheckReport = null;
  let lastBenchmarkRun = null; // { suite, strat }
  let lastRollingRun = null; // { study, cfg }

  function encodeState() {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    } catch (e) {
      return "";
    }
  }
  function decodeState(hash) {
    try {
      const json = decodeURIComponent(escape(atob(hash)));
      const parsed = JSON.parse(json);
      const def = defaultState();
      return Object.assign(def, parsed, {
        deposit: Object.assign(def.deposit, parsed.deposit),
        bounds: {
          linear: Object.assign(def.bounds.linear, parsed.bounds && parsed.bounds.linear),
          squared: Object.assign(def.bounds.squared, parsed.bounds && parsed.bounds.squared),
          threshold: Object.assign(def.bounds.threshold, parsed.bounds && parsed.bounds.threshold),
        },
        targetDeployment: Object.assign(def.targetDeployment, parsed.targetDeployment),
        lumpSumAtStart: Object.assign(def.lumpSumAtStart, parsed.lumpSumAtStart),
        threshold: Object.assign(def.threshold, parsed.threshold),
        optimizer: Object.assign(def.optimizer, parsed.optimizer),
      });
    } catch (e) {
      return null;
    }
  }
  function updateHash() {
    const encoded = encodeState();
    if (encoded) history.replaceState(null, "", "#s=" + encoded);
  }
  function loadStateFromHash() {
    const h = location.hash;
    if (h.startsWith("#s=")) {
      const decoded = decodeState(h.slice(3));
      if (decoded) state = decoded;
    }
  }

  // ---------------------------------------------------------------------
  // Controls <-> state
  // ---------------------------------------------------------------------

  const el = (id) => document.getElementById(id);

  function applyStateToControls() {
    el("startDate").value = formatDMY(state.startDate);
    el("endDate").value = formatDMY(state.endDate);
    el("fitMode").value = state.fitMode;
    el("calibration").checked = state.calibration;
    el("fundingMode").value = state.fundingMode;
    el("startingCapital").value = state.startingCapital;
    el("reserveRateAnnual").value = state.reserveRateAnnual;
    el("depositDca").value = state.deposit.dca;
    el("depositLinear").value = state.deposit.linear;
    el("depositSquared").value = state.deposit.squared;
    el("depositThreshold").value = state.deposit.threshold;
    el("mMinLinear").value = state.bounds.linear.mMin;
    el("mMaxLinear").value = state.bounds.linear.mMax;
    el("mMinSquared").value = state.bounds.squared.mMin;
    el("mMaxSquared").value = state.bounds.squared.mMax;
    el("mMinThreshold").value = state.bounds.threshold.mMin;
    el("mMaxThreshold").value = state.bounds.threshold.mMax;
    el("targetDeploymentLinear").value = state.targetDeployment.linear;
    el("targetDeploymentSquared").value = state.targetDeployment.squared;
    el("lumpSumDca").checked = state.lumpSumAtStart.dca;
    el("lumpSumLinear").checked = state.lumpSumAtStart.linear;
    el("lumpSumSquared").checked = state.lumpSumAtStart.squared;
    el("lumpSumThreshold").checked = state.lumpSumAtStart.threshold;
    el("thresholdEnabled").checked = state.threshold.enabled;
    el("thresholdEnterRatio").value = state.threshold.enterThreshold;
    el("thresholdBaseRate").value = state.threshold.baseRate;
    el("thresholdSpendFraction").value = state.threshold.reserveSpendFraction;
    el("thresholdUseBand").checked = state.threshold.useBand;
    el("thresholdBandSigma").value = state.threshold.bandSigma;
    el("optStrategy").value = state.optimizer.strategy === "squared" ? "2" : "1";
    el("optObjective").value = state.optimizer.objective;
    el("optTargetDeployment").value = state.optimizer.targetDeployment;
    updateThresholdOptionVisibility();
  }

  // The threshold strategy is off by default and only appears as a
  // selectable 4th strategy elsewhere (trace table, benchmark picker) once
  // enabled — an unrun, hidden strategy showing up in those pickers would
  // be confusing and (for the benchmark picker) would throw when run.
  function updateThresholdOptionVisibility() {
    const enabled = state.threshold.enabled;
    el("traceStrategyThresholdOpt").hidden = !enabled;
    el("benchmarkStrategyThresholdOpt").hidden = !enabled;
    if (!enabled) {
      if (el("traceStrategy").value === "3") el("traceStrategy").value = "0";
      if (el("benchmarkStrategy").value === "3") el("benchmarkStrategy").value = "1";
    }
  }

  function clearDataError() {
    const box = el("dataError");
    box.style.display = "none";
    box.textContent = "";
  }
  function showDataError(message) {
    const box = el("dataError");
    box.style.display = "block";
    box.textContent = message;
  }

  function validateDates() {
    let ok = true;
    const startStr = el("startDate").value;
    const endStr = el("endDate").value;
    const startIso = parseDMY(startStr);
    const endIso = parseDMY(endStr);

    el("startDateError").textContent = "";
    el("endDateError").textContent = "";

    if (!startIso) {
      el("startDateError").textContent = "Enter a valid date as DD.MM.YYYY.";
      ok = false;
    } else if (startIso < dataStartDate() || startIso > dataEndDate()) {
      el("startDateError").textContent = `Must be between ${formatDMY(dataStartDate())} and ${formatDMY(dataEndDate())}.`;
      ok = false;
    }
    if (!endIso) {
      el("endDateError").textContent = "Enter a valid date as DD.MM.YYYY.";
      ok = false;
    } else if (endIso < dataStartDate() || endIso > dataEndDate()) {
      el("endDateError").textContent = `Must be between ${formatDMY(dataStartDate())} and ${formatDMY(dataEndDate())}.`;
      ok = false;
    }
    if (ok && startIso >= endIso) {
      el("endDateError").textContent = "End date must be after start date.";
      ok = false;
    }
    if (ok) {
      state.startDate = startIso;
      state.endDate = endIso;
    }
    return ok;
  }

  function clampedBounds(minId, maxId) {
    let mMin = Number(el(minId).value);
    let mMax = Number(el(maxId).value);
    if (!Number.isFinite(mMin)) mMin = 0;
    if (!Number.isFinite(mMax)) mMax = mMin;
    if (mMin > mMax) [mMin, mMax] = [mMax, mMin];
    return { mMin, mMax };
  }

  function clampTargetDeployment(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 1.0;
    return B.clamp(v, 0.3, 1.0);
  }

  function readNumericControls() {
    state.fitMode = el("fitMode").value;
    state.calibration = el("calibration").checked;
    state.fundingMode = el("fundingMode").value;
    state.startingCapital = Math.max(0, Number(el("startingCapital").value) || 0);
    state.reserveRateAnnual = Number(el("reserveRateAnnual").value) || 0;

    state.deposit.dca = Math.max(0, Number(el("depositDca").value) || 0);
    state.deposit.linear = Math.max(0, Number(el("depositLinear").value) || 0);
    state.deposit.squared = Math.max(0, Number(el("depositSquared").value) || 0);
    state.deposit.threshold = Math.max(0, Number(el("depositThreshold").value) || 0);

    state.bounds.linear = clampedBounds("mMinLinear", "mMaxLinear");
    state.bounds.squared = clampedBounds("mMinSquared", "mMaxSquared");
    state.bounds.threshold = clampedBounds("mMinThreshold", "mMaxThreshold");

    state.targetDeployment.linear = clampTargetDeployment(el("targetDeploymentLinear").value);
    state.targetDeployment.squared = clampTargetDeployment(el("targetDeploymentSquared").value);

    state.lumpSumAtStart.dca = el("lumpSumDca").checked;
    state.lumpSumAtStart.linear = el("lumpSumLinear").checked;
    state.lumpSumAtStart.squared = el("lumpSumSquared").checked;
    state.lumpSumAtStart.threshold = el("lumpSumThreshold").checked;

    state.threshold.enabled = el("thresholdEnabled").checked;
    let enterRatio = Number(el("thresholdEnterRatio").value);
    state.threshold.enterThreshold = Number.isFinite(enterRatio) && enterRatio > 0 ? enterRatio : 1.3;
    state.threshold.baseRate = B.clamp(Number(el("thresholdBaseRate").value) || 0, 0, 1);
    state.threshold.reserveSpendFraction = B.clamp(Number(el("thresholdSpendFraction").value) || 0, 0, 1);
    state.threshold.useBand = el("thresholdUseBand").checked;
    state.threshold.bandSigma = Math.max(0, Number(el("thresholdBandSigma").value) || 0);
    updateThresholdOptionVisibility();

    state.optimizer.strategy = el("optStrategy").value === "2" ? "squared" : "linear";
    state.optimizer.objective = el("optObjective").value;
    state.optimizer.targetDeployment = clampTargetDeployment(el("optTargetDeployment").value);
  }

  // ---------------------------------------------------------------------
  // Core compute
  // ---------------------------------------------------------------------

  function buildStrategyDefs() {
    const defs = [
      {
        key: "dca",
        label: "1 · DCA",
        color: COLOR.dca,
        p: 0,
        deposit: state.deposit.dca,
        mMin: 0,
        mMax: 1e9,
        targetDeployment: 1,
        lumpSumAtStart: state.lumpSumAtStart.dca,
      },
      {
        key: "linear",
        label: "2 · Power-law linear",
        color: COLOR.linear,
        p: 1,
        deposit: state.deposit.linear,
        mMin: state.bounds.linear.mMin,
        mMax: state.bounds.linear.mMax,
        targetDeployment: state.targetDeployment.linear,
        lumpSumAtStart: state.lumpSumAtStart.linear,
      },
      {
        key: "squared",
        label: "3 · Power-law squared",
        color: COLOR.squared,
        p: 2,
        deposit: state.deposit.squared,
        mMin: state.bounds.squared.mMin,
        mMax: state.bounds.squared.mMax,
        targetDeployment: state.targetDeployment.squared,
        lumpSumAtStart: state.lumpSumAtStart.squared,
      },
    ];
    if (state.threshold.enabled) {
      defs.push({
        key: "threshold",
        label: "4 · Threshold reserve",
        color: COLOR.threshold,
        p: 0, // unused by the threshold branch; keeps k/mRaw well-defined (1.000) in the trace
        strategyType: "threshold",
        deposit: state.deposit.threshold,
        mMin: state.bounds.threshold.mMin,
        mMax: state.bounds.threshold.mMax,
        lumpSumAtStart: state.lumpSumAtStart.threshold,
        threshold: {
          enterThreshold: state.threshold.enterThreshold,
          baseRate: state.threshold.baseRate,
          reserveSpendFraction: state.threshold.reserveSpendFraction,
          useBand: state.threshold.useBand,
          bandSigma: state.threshold.bandSigma,
        },
      });
    }
    return defs;
  }

  function recompute() {
    clearDataError();
    let context;
    try {
      context = B.prepareFairValueContext(DATA, state.startDate, state.endDate, state.fitMode);
    } catch (err) {
      showDataError(err.message);
      lastResults = null;
      renderAll();
      return;
    }

    const fundingOpts = {
      fundingMode: state.fundingMode,
      startingCapital: state.startingCapital,
      reserveRateAnnual: state.reserveRateAnnual / 100,
    };

    const defs = buildStrategyDefs();
    const strategies = defs.map((def) => {
      const params = {
        p: def.p,
        mMin: def.mMin,
        mMax: def.mMax,
        deposit: def.deposit,
        targetDeployment: def.targetDeployment,
        strategyType: def.strategyType,
        threshold: def.threshold,
        fundingMode: fundingOpts.fundingMode,
        startingCapital: fundingOpts.startingCapital,
        reserveRateAnnual: fundingOpts.reserveRateAnnual,
        lumpSumAtStart: def.lumpSumAtStart,
      };
      const { trace, kMin, kMax, result } = B.runLedger(DATA, context, params, state.calibration);
      const metrics = B.computeMetrics(DATA, trace, def.deposit, state.endDate, {
        ledgerResult: result,
        startingCapital: fundingOpts.startingCapital,
      });
      return { ...def, trace, metrics, kMin, kMax };
    });

    const baseline = strategies[0];
    for (const s of strategies) {
      s.comparison = B.compareToBaseline(s.metrics, baseline.metrics);
    }

    const committed = strategies.map((s) => s.metrics.totalCommitted);
    const committedMismatch = !committed.every((c) => Math.abs(c - committed[0]) < 0.005);

    lastResults = { context, strategies, baseline, fundingOpts, committedMismatch };
    updateHash();
    renderAll();
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function renderAll() {
    const unbound = !!lastResults && lastResults.fundingOpts.fundingMode === "unbound";
    el("unboundBanner").hidden = !unbound;
    document.body.classList.toggle("diagnostic-mode", unbound);
    renderResultsTable();
    renderPriceChart();
    renderValueChart();
    renderReserveChart();
    renderMultiplierChart();
    renderTraceTable();
  }

  // colLabels (one per cell, optional) becomes each cell's data-label — the
  // column header shown when this row stacks into label/value lines below
  // the 600px breakpoint (see index.html's table.results mobile CSS).
  function metricRow(label, cells, colLabels) {
    return `<tr><td>${label}</td>${cells
      .map((c, i) => `<td${colLabels ? ` data-label="${colLabels[i]}"` : ""}>${c}</td>`)
      .join("")}</tr>`;
  }

  function renderResultsTable() {
    const table = el("resultsTable");
    if (!lastResults) {
      table.innerHTML = "";
      el("resultsHeadline").textContent = "Run the backtest to see results.";
      return;
    }
    const { strategies, committedMismatch } = lastResults;

    el("committedMismatchHint").hidden = !committedMismatch;

    const colLabels = strategies.map((s) => s.label);
    const row = (label, cells) => metricRow(label, cells, colLabels);

    let html = `<thead><tr><th>Metric</th>${strategies.map((s) => `<th style="color:${s.color}">${s.label}</th>`).join("")}</tr></thead><tbody>`;

    html += row("Total deposited", strategies.map((s) => fmtUsd(s.metrics.deposited)));
    html += row("Total committed (incl. starting capital)", strategies.map((s) => fmtUsd(s.metrics.totalCommitted)));
    html += row("Total invested", strategies.map((s) => fmtUsd(s.metrics.invested)));
    html += row("Deployment rate", strategies.map((s) => fmtPct(s.metrics.deploymentRate)));
    html += row("Cash left", strategies.map((s) => fmtUsd(s.metrics.cashLeft)));
    html += row("BTC accumulated", strategies.map((s) => fmtBtc(s.metrics.btcAccumulated)));
    html += row("Average cost basis", strategies.map((s) => fmtUsd(s.metrics.avgCostBasis)));
    html += row("BTC value at end", strategies.map((s) => fmtUsd(s.metrics.btcValue)));
    html += row("Total value", strategies.map((s) => fmtUsd(s.metrics.totalValue)));
    html += row("MoIC (on invested)", strategies.map((s) => fmtX(s.metrics.moicOnInvested)));
    html += row("MoIC (on committed)", strategies.map((s) => fmtX(s.metrics.moicOnCommitted)));
    html += row("XIRR (incl. starting capital at t0)", strategies.map((s) => fmtPct(s.metrics.xirr)));
    html += row(
      "Starved months",
      strategies.map((s) => `${s.metrics.starvedMonths} (${fmtPct(s.metrics.starvedMonthsPct, 1)})`)
    );
    html += row(
      "Unmet demand",
      strategies.map((s) => `${fmtUsd(s.metrics.unmetDemand)} (${fmtPct(s.metrics.unmetDemandPct, 1)})`)
    );
    html += row("Reserve max", strategies.map((s) => fmtUsd(s.metrics.reserveMax)));
    html += row("Reserve mean", strategies.map((s) => fmtUsd(s.metrics.reserveMean)));
    html += row("Reserve months at zero", strategies.map((s) => String(s.metrics.reserveMonthsAtZero)));
    if (state.calibration) {
      html += row(
        "k used (range)",
        strategies.map((s) => (s.strategyType === "threshold" || s.p === 0 ? "n/a" : `${fmtNum(s.kMin, 3)} – ${fmtNum(s.kMax, 3)}`))
      );
    }

    html += `<tr><td colspan="${strategies.length + 1}" style="padding-top:0.9rem; color:var(--muted); font-family:var(--sans); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.04em;">vs. strategy 1 (DCA baseline)</td></tr>`;
    if (committedMismatch) {
      html += `<tr><td colspan="${strategies.length + 1}" style="color:var(--red); font-family:var(--sans); font-size:0.8rem;">Total committed capital differs between strategies (see row above) — deltas withheld, not shown as a comparison.</td></tr>`;
    } else {
      html += row(
        "Δ BTC accumulated",
        strategies.map((s) => (s === lastResults.baseline ? "—" : fmtPct(s.comparison.deltaBtcPct)))
      );
      html += row(
        "Δ total value",
        strategies.map((s) =>
          s === lastResults.baseline ? "—" : `${fmtUsd(s.comparison.deltaTotalValue)} (${fmtPct(s.comparison.deltaTotalValuePct)})`
        )
      );
      html += row(
        "Δ XIRR",
        strategies.map((s) =>
          s === lastResults.baseline
            ? "—"
            : s.comparison.deltaXirrPts == null
            ? "—"
            : (s.comparison.deltaXirrPts >= 0 ? "+" : "") + fmtNum(s.comparison.deltaXirrPts * 100, 2) + " pp"
        )
      );
    }

    html += "</tbody>";
    table.innerHTML = html;

    const best = strategies.reduce((a, b) => (b.metrics.xirr != null && (a.metrics.xirr == null || b.metrics.xirr > a.metrics.xirr) ? b : a));
    el("resultsHeadline").textContent = `${strategies.length} strategies · best XIRR ${fmtPct(best.metrics.xirr)} (${best.label})`;
  }

  function computeFullSampleFit() {
    const endDate = dataEndDate();
    const fit = PL.fitPowerLaw(DATA, DATA.startDate, endDate);
    let sumSq = 0;
    let n = 0;
    const fair = new Array(DATA.closes.length);
    for (let i = 0; i < DATA.closes.length; i++) {
      const d = PL.addDays(DATA.startDate, i);
      const days = PL.daysSinceGenesis(d);
      const f = fit.A * Math.pow(days, fit.n);
      fair[i] = f;
      const price = DATA.closes[i];
      if (price > 0 && days > 0) {
        const resid = Math.log(price) - Math.log(f);
        sumSq += resid * resid;
        n++;
      }
    }
    const sigma = n > 0 ? Math.sqrt(sumSq / n) : 0;
    return { fit, fair, sigma };
  }

  let fullSampleFitCache = null;
  function renderPriceChart() {
    if (!fullSampleFitCache) fullSampleFitCache = computeFullSampleFit();
    const container = el("priceChart");
    if (priceChartInstance) {
      priceChartInstance.destroy();
      priceChartInstance = null;
    }
    const days = new Array(DATA.closes.length);
    const dates = new Array(DATA.closes.length);
    for (let i = 0; i < DATA.closes.length; i++) {
      dates[i] = PL.addDays(DATA.startDate, i);
      days[i] = PL.daysSinceGenesis(dates[i]);
    }
    priceChartInstance = Charts.createPriceChart(
      container,
      { days, dates, close: DATA.closes, fair: fullSampleFitCache.fair, sigma: fullSampleFitCache.sigma },
      (startDate, endDate) => {
        if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
        startDate = clampToDataRange(startDate);
        endDate = clampToDataRange(endDate);
        el("startDate").value = formatDMY(startDate);
        el("endDate").value = formatDMY(endDate);
        // Deferred: this fires from inside uPlot's own mouseup handler, and
        // recompute() below destroys/recreates the chart instance. Doing
        // that synchronously, mid-handler, stops uPlot from unregistering
        // its own document-level mouseup listener (it clears its internal
        // bookkeeping before reaching that step), leaking a stale listener
        // that replays this exact selection on every later click anywhere
        // on the page. Yielding first lets uPlot finish its own handler.
        setTimeout(onControlsChanged, 0);
      }
    );
    Charts.setPriceChartSelection(priceChartInstance, state.startDate, state.endDate);
  }

  function clampToDataRange(iso) {
    if (iso < dataStartDate()) return dataStartDate();
    if (iso > dataEndDate()) return dataEndDate();
    return iso;
  }

  function destroyIfExists(inst) {
    if (inst) inst.destroy();
    return null;
  }

  function renderValueChart() {
    valueChartInstance = destroyIfExists(valueChartInstance);
    const container = el("valueChart");
    container.innerHTML = "";
    if (!lastResults) return;
    const dates = lastResults.strategies[0].trace.map((r) => r.date);
    const series = lastResults.strategies.map((s) => ({
      label: s.label,
      color: s.color,
      values: s.trace.map((r) => r.portfolioValue),
    }));
    valueChartInstance = Charts.createTimeSeriesChart(container, dates, series, {
      logScale: el("valueLogToggle").checked,
      yFormat: (v) => "$" + fmtNum(v, 0),
    });
  }

  function renderReserveChart() {
    reserveChartInstance = destroyIfExists(reserveChartInstance);
    const container = el("reserveChart");
    container.innerHTML = "";
    if (!lastResults) return;
    const dates = lastResults.strategies[0].trace.map((r) => r.date);
    const series = lastResults.strategies.map((s) => ({
      label: s.label,
      color: s.color,
      values: s.trace.map((r) => r.balance),
    }));
    reserveChartInstance = Charts.createTimeSeriesChart(container, dates, series, {
      yFormat: (v) => "$" + fmtNum(v, 0),
    });
  }

  function renderMultiplierChart() {
    multiplierChartInstance = destroyIfExists(multiplierChartInstance);
    const container = el("multiplierChart");
    container.innerHTML = "";
    if (!lastResults) return;
    const dates = lastResults.strategies[0].trace.map((r) => r.date);
    const series = lastResults.strategies.map((s) => ({
      label: s.label,
      color: s.color,
      values: s.trace.map((r) => r.m),
    }));
    const hLines = [];
    for (const s of lastResults.strategies) {
      if (s.key === "dca") continue;
      hLines.push({ value: s.mMin, label: s.label + " min" });
      hLines.push({ value: s.mMax, label: s.label + " max" });
    }
    multiplierChartInstance = Charts.createTimeSeriesChart(container, dates, series, {
      yFormat: (v) => fmtNum(v, 2),
      hLines,
    });
  }

  function renderTraceTable() {
    const table = el("traceTable");
    if (!lastResults) {
      table.innerHTML = "";
      return;
    }
    const idx = Number(el("traceStrategy").value);
    const trace = lastResults.strategies[idx].trace;
    const headers = ["Date", "Price", "PL fair", "m raw", "k", "m", "Desired", "Spend", "Balance", "BTC", "Portfolio", "Starved"];
    let html = "<thead><tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr></thead><tbody>";
    for (const r of trace) {
      html += `<tr>
        <td>${formatDMY(r.date)}</td>
        <td>${fmtUsd(r.price)}</td>
        <td>${fmtUsd(r.plFair)}</td>
        <td>${fmtNum(r.mRaw, 3)}</td>
        <td>${fmtNum(r.k, 3)}</td>
        <td>${fmtNum(r.m, 3)}</td>
        <td>${fmtUsd(r.desired)}</td>
        <td>${fmtUsd(r.spend)}</td>
        <td>${fmtUsd(r.balance)}</td>
        <td>${fmtBtc(r.btc)}</td>
        <td>${fmtUsd(r.portfolioValue)}</td>
        <td>${r.starved ? "yes" : ""}</td>
      </tr>`;
    }
    html += "</tbody>";
    table.innerHTML = html;
  }

  function traceToCsv(trace, label) {
    const headers = ["date", "price", "plFair", "mRaw", "k", "m", "desired", "spend", "balance", "btc", "portfolioValue", "starved"];
    const lines = [headers.join(",")];
    for (const r of trace) {
      lines.push(headers.map((h) => (typeof r[h] === "boolean" ? r[h] : r[h])).join(","));
    }
    return lines.join("\n");
  }

  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------
  // Optimizer
  // ---------------------------------------------------------------------

  function round2(x) {
    return Math.round(x * 100) / 100;
  }
  function heatmapAxisValues() {
    const mins = [];
    for (let i = 0; round2(i * Optimizer.MMIN_STEP) <= Optimizer.MMIN_MAX + 1e-9; i++) mins.push(round2(i * Optimizer.MMIN_STEP));
    const maxs = [];
    for (let j = 0; ; j++) {
      const v = round2(Optimizer.MMAX_MIN + j * Optimizer.MMAX_STEP);
      if (v > Optimizer.MMAX_MAX + 1e-9) break;
      maxs.push(v);
    }
    return { mins, maxs };
  }

  let optimizerWorker = null;

  function runOptimizer() {
    if (!validateDates()) return;
    readNumericControls();

    if (state.fundingMode === "unbound") {
      el("optimizerUnboundWarning").hidden = false;
      return;
    }
    el("optimizerUnboundWarning").hidden = true;

    const strategyKey = state.optimizer.strategy;
    const p = strategyKey === "squared" ? 2 : 1;
    const opts = {
      p,
      startDate: state.startDate,
      endDate: state.endDate,
      deposit: state.deposit[strategyKey],
      targetDeployment: state.optimizer.targetDeployment,
      fundingMode: state.fundingMode,
      startingCapital: state.startingCapital,
      reserveRateAnnual: state.reserveRateAnnual / 100,
      lumpSumAtStart: state.lumpSumAtStart[strategyKey],
      fitMode: state.fitMode,
      calibrationOn: state.calibration,
      objective: state.optimizer.objective,
    };

    el("optimizerProgress").hidden = false;
    el("optimizerResults").hidden = true;
    el("optimizerProgressBar").value = 0;
    el("optimizerProgressLabel").textContent = "Starting sweep…";
    el("runOptimizerBtn").disabled = true;

    const onProgress = (done, total) => {
      const pct = Math.round((done / total) * 100);
      el("optimizerProgressBar").value = pct;
      el("optimizerProgressLabel").textContent = `${done} / ${total} boundary combinations evaluated`;
    };
    const onDone = (result) => {
      el("optimizerProgress").hidden = true;
      el("runOptimizerBtn").disabled = false;
      renderOptimizerResults(result, opts);
    };
    const onError = (err) => {
      el("optimizerProgress").hidden = true;
      el("runOptimizerBtn").disabled = false;
      showDataError("Optimizer failed: " + err.message);
    };

    runSweepWithFallback(opts, onProgress, onDone, onError);
  }

  function runSweepWithFallback(opts, onProgress, onDone, onError) {
    let settled = false;
    let worker;
    try {
      worker = new Worker("js/optimizer-worker.js");
    } catch (e) {
      runChunkedMainThread(opts, onProgress, onDone, onError);
      return;
    }
    optimizerWorker = worker;

    const fallbackTimer = setTimeout(() => {
      if (!settled) {
        worker.terminate();
        runChunkedMainThread(opts, onProgress, onDone, onError);
      }
    }, 1500);

    worker.onmessage = (e) => {
      const msg = e.data;
      settled = true;
      clearTimeout(fallbackTimer);
      if (msg.type === "progress") {
        onProgress(msg.done, msg.total);
      } else if (msg.type === "done") {
        worker.terminate();
        onDone(msg.result);
      } else if (msg.type === "error") {
        worker.terminate();
        onError(new Error(msg.message));
      }
    };
    worker.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(fallbackTimer);
        worker.terminate();
        runChunkedMainThread(opts, onProgress, onDone, onError);
      }
    };
    worker.postMessage(opts);
  }

  function runChunkedMainThread(opts, onProgress, onDone, onError) {
    try {
      const context = B.prepareFairValueContext(DATA, opts.startDate, opts.endDate, opts.fitMode);
      const baseline = Optimizer.computeBaseline(DATA, context, opts);
      const grid = Optimizer.generateGrid();
      const cells = [];
      let i = 0;
      function step() {
        const batchEnd = Math.min(i + 40, grid.length);
        for (; i < batchEnd; i++) {
          const { mMin, mMax } = grid[i];
          cells.push(Optimizer.evaluateCell(DATA, context, opts, mMin, mMax));
        }
        onProgress(i, grid.length);
        if (i < grid.length) {
          setTimeout(step, 0);
        } else {
          const ranked = cells
            .filter((c) => c.objectiveValue != null && Number.isFinite(c.objectiveValue))
            .sort((a, b) => b.objectiveValue - a.objectiveValue);
          const top10 = ranked.slice(0, 10);
          const robustness = top10.length ? Optimizer.runRobustness(DATA, opts, top10[0].mMin, top10[0].mMax) : null;
          onDone({ baseline, cells, top10, robustness });
        }
      }
      step();
    } catch (err) {
      onError(err);
    }
  }

  function renderOptimizerResults(result, opts) {
    el("optimizerResults").hidden = false;
    const { mins, maxs } = heatmapAxisValues();
    const baselineValue = Optimizer.objectiveValue(result.baseline, opts.objective);

    const tooltip = el("heatmapTooltip");
    Charts.createHeatmap(el("heatmapContainer2"), result.cells, baselineValue, mins, maxs, (entry, x, y) => {
      if (!entry) {
        tooltip.hidden = true;
        return;
      }
      tooltip.hidden = false;
      tooltip.style.left = x + 12 + "px";
      tooltip.style.top = y + 12 + "px";
      tooltip.textContent = `mMin ${fmtNum(entry.mMin, 2)} · mMax ${fmtNum(entry.mMax, 2)} · ${formatObjective(entry.objectiveValue, opts.objective)} (${entry.delta >= 0 ? "+" : ""}${fmtNum(entry.delta * 100, 1)}% vs DCA)`;
    });

    let html = `<thead><tr><th>#</th><th>mMin</th><th>mMax</th><th>${objectiveLabel(opts.objective)}</th><th>Δ BTC vs DCA</th><th>Total value</th><th>XIRR</th></tr></thead><tbody>`;
    result.top10.forEach((c, i) => {
      const cmp = B.compareToBaseline(c.metrics, result.baseline);
      html += `<tr>
        <td>${i + 1}</td>
        <td data-label="mMin">${fmtNum(c.mMin, 2)}</td>
        <td data-label="mMax">${fmtNum(c.mMax, 2)}</td>
        <td data-label="${objectiveLabel(opts.objective)}">${formatObjective(c.objectiveValue, opts.objective)}</td>
        <td data-label="Δ BTC vs DCA">${fmtPct(cmp.deltaBtcPct)}</td>
        <td data-label="Total value">${fmtUsd(c.metrics.totalValue)}</td>
        <td data-label="XIRR">${fmtPct(c.metrics.xirr)}</td>
      </tr>`;
    });
    html += "</tbody>";
    el("top10Table").innerHTML = html;

    const grid = el("robustnessGrid");
    grid.innerHTML = "";
    if (result.robustness) {
      for (const r of result.robustness) {
        const card = document.createElement("div");
        card.className = "robustness-card " + (!r.available ? "na" : r.beatsBaseline ? "win" : "lose");
        if (!r.available) {
          card.innerHTML = `<strong>${r.label}</strong><div class="chart-hint">${r.reason || "insufficient history"}</div>`;
        } else {
          const cmp = r.comparison;
          card.innerHTML = `<strong>${r.label}</strong><div class="chart-hint">${r.beatsBaseline ? "Beats" : "Underperforms"} DCA · Δ BTC ${fmtPct(cmp.deltaBtcPct)} · Δ XIRR ${cmp.deltaXirrPts == null ? "—" : fmtNum(cmp.deltaXirrPts * 100, 2) + " pp"}</div>`;
        }
        grid.appendChild(card);
      }
    }
  }

  function objectiveLabel(objective) {
    if (objective === "totalValue") return "Total value";
    if (objective === "xirr") return "XIRR";
    return "BTC accumulated";
  }
  function formatObjective(v, objective) {
    if (objective === "totalValue") return fmtUsd(v);
    if (objective === "xirr") return fmtPct(v);
    return fmtBtc(v);
  }

  // ---------------------------------------------------------------------
  // Panel A: data verification
  // ---------------------------------------------------------------------

  const BACKTEST_CONTROL_IDS = [
    "startDate",
    "endDate",
    "fitMode",
    "calibration",
    "fundingMode",
    "startingCapital",
    "reserveRateAnnual",
    "depositDca",
    "depositLinear",
    "depositSquared",
    "depositThreshold",
    "mMinLinear",
    "mMaxLinear",
    "mMinSquared",
    "mMaxSquared",
    "mMinThreshold",
    "mMaxThreshold",
    "targetDeploymentLinear",
    "targetDeploymentSquared",
    "lumpSumDca",
    "lumpSumLinear",
    "lumpSumSquared",
    "lumpSumThreshold",
    "thresholdEnabled",
    "thresholdEnterRatio",
    "thresholdBaseRate",
    "thresholdSpendFraction",
    "thresholdUseBand",
    "thresholdBandSigma",
    "resetBtn",
    "runOptimizerBtn",
    "runBenchmarkBtn",
    "runRollingBtn",
    "runSweepBtn",
  ];

  function disableBacktestControls(message) {
    BACKTEST_CONTROL_IDS.forEach((id) => {
      const target = el(id);
      if (target) target.disabled = true;
    });
    showDataError(message);
  }

  function renderAnchorTable(anchors) {
    let html = "<thead><tr><th>Date</th><th>Note</th><th>Expected</th><th>Found</th><th>Deviation</th><th>Result</th></tr></thead><tbody>";
    for (const a of anchors) {
      const resultCell = a.pass
        ? '<span style="color:var(--green)">PASS</span>'
        : `<span style="color:var(--red)">${a.detail || "FAIL"}</span>`;
      html += `<tr>
        <td>${formatDMY(a.date)}</td>
        <td data-label="Note">${a.note}</td>
        <td data-label="Expected">${fmtUsd(a.price)}</td>
        <td data-label="Found">${a.local == null ? "—" : fmtUsd(a.local)}</td>
        <td data-label="Deviation">${a.devPct == null ? "—" : fmtNum(a.devPct, 2) + "%"}</td>
        <td data-label="Result">${resultCell}</td>
      </tr>`;
    }
    html += "</tbody>";
    el("anchorTable").innerHTML = html;
  }

  function renderShapeTable(shape) {
    const rows = [
      ["Annualised volatility", fmtNum(shape.annualVol, 1) + "%", "roughly 45–75% in recent years; the full 2010– history runs higher"],
      ["Share of days moving >5%", fmtNum(shape.bigMovePct, 1) + "%", "roughly 3–5% in recent years"],
      ["Kurtosis", fmtNum(shape.kurtosis, 1), "well above 3; near 3 suggests a normal-distributed (synthetic) series"],
      ["Repeated closes", fmtNum(shape.repeatedClosePct, 2) + "%", "near 0% for real daily data; high values suggest padding"],
      ["Last date in file", formatDMY(shape.lastDate), "—"],
      ["Last close in file", fmtUsd(shape.lastClose), "—"],
    ];
    let html = "<thead><tr><th>Metric</th><th>Value</th><th>Expected range</th></tr></thead><tbody>";
    for (const [label, val, exp] of rows) {
      html += `<tr><td>${label}</td><td data-label="Value">${val}</td><td data-label="Expected range">${exp}</td></tr>`;
    }
    html += "</tbody>";
    el("shapeTable").innerHTML = html;
  }

  let verifyChartInstance = null;
  function renderVerifyOverlayChart(series) {
    verifyChartInstance = destroyIfExists(verifyChartInstance);
    const dates = series.map((r) => r.date);
    const committed = series.map((r) => r.local);
    const live = series.map((r) => r.live);
    verifyChartInstance = Charts.createTimeSeriesChart(
      el("verifyOverlayChart"),
      dates,
      [
        { label: "Committed", color: COLOR.dca, values: committed },
        { label: "Live", color: COLOR.linear, values: live },
      ],
      { height: 200, yFormat: (v) => "$" + fmtNum(v, 0) }
    );
    el("verifyOverlayHint").hidden = false;
  }

  // ---------------------------------------------------------------------
  // Mobile-readable data-check report: one function computes every check
  // (sync ones instantly, the live-source check once its fetch resolves),
  // and both the on-page panel and the "DATA CHECK" copy-to-clipboard block
  // render from the exact same report object — so the two can never drift
  // apart or disagree about a run.
  // ---------------------------------------------------------------------

  // Recent-window shape diagnostics, not full-history: BTC's 2010-13 years
  // are far more volatile than anything since, so a full-history annualised
  // vol/big-move-day check would flag every real snapshot as out of range
  // (see the "roughly ... in recent years" caveats already on the raw
  // shape table below). A trailing 2-year window is what the expected
  // ranges below are actually calibrated against.
  function recentShapeDiagnostics(data, days) {
    days = days || 730;
    const n = data.closes.length;
    const start = Math.max(0, n - days);
    const slice = {
      startDate: PL.addDays(data.startDate, start),
      closes: data.closes.slice(start),
    };
    return DataCheck.shapeDiagnostics(slice);
  }

  function computeAthCheck() {
    const ath = DataCheck.findATH(DATA);
    const anchor = DataCheck.ANCHORS.find((a) => a.note === "all-time high");
    const devPct = anchor ? (100 * Math.abs(ath.price - anchor.price)) / anchor.price : null;
    const pass = anchor ? devPct <= anchor.tolerancePct : null;
    return { ath, anchor, devPct, pass };
  }

  // The hard, structural checks computable instantly with no network:
  // these (plus the live-source check once it resolves) are what decide
  // the verdict strip and whether backtest controls get disabled. Shape
  // diagnostics (volatility/big-move-days/kurtosis/repeats) get their own
  // chips below but stay advisory only — see recentShapeDiagnostics' note
  // and the original design rationale in README.md.
  function buildSyncDataCheck() {
    const health = DataCheck.dataHealth(DATA);
    const stale = DataCheck.staleDays(health.lastDate);
    const shape = recentShapeDiagnostics(DATA);
    return {
      health,
      stale,
      freshnessPass: stale <= 3,
      gapsPass: health.gapDays === 0,
      zerosPass: health.zeroOrNegativeCount === 0,
      athCheck: computeAthCheck(),
      shape,
      volPass: shape.annualVol >= 45 && shape.annualVol <= 75,
      bigMovePass: shape.bigMovePct >= 3 && shape.bigMovePct <= 5,
      kurtosisPass: shape.kurtosis > 5,
      repeatsPass: shape.repeatedClosePct <= 1,
      live: undefined, // undefined = still checking; null = unavailable; object = resolved
    };
  }

  function hardFail(report) {
    if (!report.freshnessPass) return `series ends ${formatDMY(report.health.lastDate)}, ${report.stale} days stale`;
    if (!report.gapsPass) return `${report.health.gapDays} date gap${report.health.gapDays === 1 ? "" : "s"} in the committed series`;
    if (!report.zerosPass) return `${report.health.zeroOrNegativeCount} zero/negative close(s) in the committed series`;
    if (report.athCheck.pass === false) {
      return `all-time high off by ${fmtNum(report.athCheck.devPct, 1)}% vs. the ${fmtUsd(report.athCheck.anchor.price)} anchor`;
    }
    if (report.live && report.live.overlapPass === false) {
      return `live source mismatch, ${fmtNum(report.live.medianAbsPct, 1)}% median deviation`;
    }
    return null;
  }

  function renderVerdictStrip(report) {
    const strip = el("verdictStrip");
    const reason = hardFail(report);
    let text;
    let cls;
    if (report.live === undefined) {
      cls = "checking";
      text = "Checking committed data…";
    } else if (reason) {
      cls = "fail";
      text = `DATA FAILED — ${reason}`;
    } else {
      cls = "pass";
      text = `DATA OK — ${fmtNum(report.health.rows, 0)} days, through ${formatDMY(report.health.lastDate)}`;
    }
    strip.className = "verdict-strip " + cls;
    strip.textContent = text;
    el("dataVerifyHeadline").textContent = text;
    return { pass: report.live !== undefined && !reason, reason };
  }

  function numRow(label, value, opts) {
    opts = opts || {};
    const chip = opts.pass == null ? "" : `<span class="chip-dot ${opts.pass ? "pass" : "fail"}"></span>`;
    const sub = opts.expected != null ? `<div class="num-sub">${chip}${opts.expected}</div>` : "";
    return `<div class="num-row${opts.bold ? " ath" : ""}">
      <div class="num-top"><span class="num-label">${label}</span><span class="num-value">${value}</span></div>
      ${sub}
    </div>`;
  }

  function renderNumbersBlock(report) {
    const h = report.health;
    const rows = [];
    rows.push(
      numRow("Last date", formatDMY(h.lastDate), { pass: report.freshnessPass, expected: `${report.stale}d stale · expect ≤3d` })
    );
    rows.push(numRow("Last close", fmtUsd(h.lastClose)));
    rows.push(numRow("Rows", fmtNum(h.rows, 0)));
    rows.push(numRow("Date gaps", fmtNum(h.gapDays, 0), { pass: report.gapsPass, expected: "expect 0" }));
    rows.push(
      numRow("Zero or negative closes", fmtNum(h.zeroOrNegativeCount, 0), { pass: report.zerosPass, expected: "expect 0" })
    );
    const ac = report.athCheck;
    rows.push(
      numRow("ATH found", `${fmtUsd(ac.ath.price)} on ${formatDMY(ac.ath.date)}`, {
        pass: ac.pass,
        expected: ac.anchor ? `expect ${fmtUsd(ac.anchor.price)} ±${ac.anchor.tolerancePct}%` : "",
        bold: true,
      })
    );
    if (report.live === undefined) {
      rows.push(numRow("Live overlap match", "checking…"));
    } else if (report.live === null) {
      rows.push(numRow("Live overlap match", "unavailable", { expected: "network unreachable (expected under file://)" }));
    } else {
      rows.push(
        numRow("Live overlap match", `${fmtNum(report.live.medianAbsPct, 1)}% median dev`, {
          pass: report.live.overlapPass,
          expected: "expect ≤2%",
        })
      );
    }
    rows.push(numRow("Annual volatility", fmtNum(report.shape.annualVol, 1) + "%", { pass: report.volPass, expected: "expect 45–75% (2y)" }));
    rows.push(numRow("Days moving >5%", fmtNum(report.shape.bigMovePct, 1) + "%", { pass: report.bigMovePass, expected: "expect 3–5% (2y)" }));
    rows.push(numRow("Kurtosis", fmtNum(report.shape.kurtosis, 1), { pass: report.kurtosisPass, expected: "expect >5" }));
    rows.push(numRow("Repeated closes", fmtNum(report.shape.repeatedClosePct, 1) + "%", { pass: report.repeatsPass, expected: "expect ≤1%" }));
    el("numbersBlock").innerHTML = rows.join("");
  }

  function renderDataCheckPanel() {
    renderVerdictStrip(lastDataCheckReport);
    renderNumbersBlock(lastDataCheckReport);
  }

  function applyDataCheckVerdict() {
    const reason = hardFail(lastDataCheckReport);
    if (reason) {
      disableBacktestControls(`Data verification failed: ${reason}. Backtest controls are disabled until this is resolved.`);
    }
    return reason;
  }

  async function runDataVerification() {
    lastDataCheckReport = buildSyncDataCheck();
    renderDataCheckPanel();

    const anchors = DataCheck.checkAnchors(DATA);
    renderAnchorTable(anchors);
    renderShapeTable(DataCheck.shapeDiagnostics(DATA));

    console.log(buildDataSummaryText());

    // Sync checks (freshness/gaps/zeros/ATH) already fully decide the
    // verdict on their own — disable immediately rather than waiting on a
    // network round trip that may be slow or (under file://) never resolve.
    applyDataCheckVerdict();

    let live = null;
    try {
      const raw = await DataCheck.verifyAgainstLive(DATA);
      live = { ...raw, overlapPass: raw.medianAbsPct != null ? raw.medianAbsPct <= 2 : null };
    } catch (err) {
      live = null; // unavailable (no network / CORS under file://) — not a failure
    }
    lastDataCheckReport.live = live;
    renderDataCheckPanel();
    console.log(buildDataSummaryText());
    applyDataCheckVerdict();

    if (live && live.series && live.series.length) {
      renderVerifyOverlayChart(live.series);
    }
  }

  // ---------------------------------------------------------------------
  // Panel B: benchmarks (ceiling, floor, permutation significance)
  // ---------------------------------------------------------------------

  let allocationChartHandle = null;

  function currentBenchmarkStrategy() {
    const val = el("benchmarkStrategy").value;
    if (val === "3" && state.threshold.enabled) {
      return {
        key: "threshold",
        name: "4 · Threshold reserve",
        strategyType: "threshold",
        mMin: state.bounds.threshold.mMin,
        mMax: state.bounds.threshold.mMax,
        deposit: state.deposit.threshold,
        lumpSumAtStart: state.lumpSumAtStart.threshold,
        threshold: {
          enterThreshold: state.threshold.enterThreshold,
          baseRate: state.threshold.baseRate,
          reserveSpendFraction: state.threshold.reserveSpendFraction,
          useBand: state.threshold.useBand,
          bandSigma: state.threshold.bandSigma,
        },
      };
    }
    const key = val === "2" ? "squared" : "linear";
    return {
      key,
      name: key === "linear" ? "2 · Power-law linear" : "3 · Power-law squared",
      exponent: key === "linear" ? 1 : 2,
      mMin: state.bounds[key].mMin,
      mMax: state.bounds[key].mMax,
      deposit: state.deposit[key],
      targetDeployment: state.targetDeployment[key],
      lumpSumAtStart: state.lumpSumAtStart[key],
    };
  }

  function runBenchmarks() {
    if (!validateDates()) return;
    readNumericControls();
    const strat = currentBenchmarkStrategy();

    const cfg = {
      startDate: state.startDate,
      endDate: state.endDate,
      deposit: strat.deposit,
      fitMode: state.fitMode,
      calibrate: state.calibration,
      fundingMode: state.fundingMode,
      startingCapital: state.startingCapital,
      reserveRateAnnual: state.reserveRateAnnual / 100,
      strategies: [
        strat.strategyType === "threshold"
          ? {
              name: strat.name,
              strategyType: "threshold",
              mMin: strat.mMin,
              mMax: strat.mMax,
              threshold: strat.threshold,
              lumpSumAtStart: strat.lumpSumAtStart,
            }
          : {
              name: strat.name,
              exponent: strat.exponent,
              mMin: strat.mMin,
              mMax: strat.mMax,
              targetDeployment: strat.targetDeployment,
              lumpSumAtStart: strat.lumpSumAtStart,
            },
      ],
    };

    let suite;
    try {
      suite = Benchmarks.runBenchmarkSuite(cfg);
    } catch (err) {
      showDataError("Benchmark failed: " + err.message);
      return;
    }
    clearDataError();
    el("benchmarkResults").hidden = false;
    lastBenchmarkRun = { suite, strat };
    renderBenchmarkHeadline(suite, strat);
    renderAllocationChart(suite, strat);
    refreshPermutationView();
  }

  // r.permutation is the legacy multiplier-permutation test (invalid for
  // threshold — see benchmarks.js); r.signalPermutation is the default,
  // valid for every strategy type. The toggle only changes which of the two
  // already-computed results is displayed, so switching it never re-runs
  // the (expensive) permutation simulation.
  function selectedPermutation(r) {
    return el("legacyPermutationToggle").checked ? r.permutation : r.signalPermutation;
  }

  // Re-renders everything that depends on which permutation test is
  // selected, from the cached suite — called after a fresh run and again
  // whenever the legacy toggle changes.
  function refreshPermutationView() {
    if (!lastBenchmarkRun) return;
    const { suite, strat } = lastBenchmarkRun;
    renderPermutationChart(suite);
    renderDiagnosticsTable(suite);
    const r = suite.results[0];
    const perm = selectedPermutation(r);
    el("benchmarksHeadline").textContent = `${strat.name}: ${r.deltaVsDcaPct >= 0 ? "+" : ""}${fmtNum(r.deltaVsDcaPct, 1)}% vs. DCA · p ${fmtNum(perm.pValue, 3)}`;
  }

  function renderBenchmarkHeadline(suite, strat) {
    const r = suite.results[0];
    const sign = (v) => (v >= 0 ? "+" : "");
    const html = `
      <div class="headline-item ceiling">
        <div class="label">Maximum possible edge over DCA</div>
        <div class="value">${sign(suite.maxPossibleEdgePct)}${fmtNum(suite.maxPossibleEdgePct, 1)}%</div>
        <div class="sub">perfect foresight</div>
      </div>
      <div class="headline-item best">
        <div class="label">${strat.name}</div>
        <div class="value">${sign(r.deltaVsDcaPct)}${fmtNum(r.deltaVsDcaPct, 1)}%</div>
        <div class="sub">${r.capture == null ? "no headroom to capture" : `captured ${fmtNum(r.capture * 100, 0)}% of it`}</div>
      </div>
      <div class="headline-item floor">
        <div class="label">Worst possible timing</div>
        <div class="value">${fmtNum(suite.minPossibleEdgePct, 1)}%</div>
        <div class="sub">always buying the local top</div>
      </div>
    `;
    el("benchmarkHeadline").innerHTML = html;
  }

  function renderAllocationChart(suite, strat) {
    const r = suite.results[0];
    allocationChartHandle = Charts.createAllocationChart(
      el("allocationChart"),
      suite.dates,
      Array.from(suite.ceiling.spendAt),
      Array.from(r.run.spendTrace),
      Array.from(suite.prices),
      { color: COLOR[strat.key] || COLOR.linear, height: 220 }
    );
  }

  function renderPermutationChart(suite) {
    const r = suite.results[0];
    const legacy = el("legacyPermutationToggle").checked;
    const perm = selectedPermutation(r);

    el("permutationModeHint").textContent = legacy
      ? "LEGACY — invalid for the threshold strategy: this shuffles the MULTIPLIER array directly (same multipliers, only which month each lands on changes). A threshold strategy's multiplier already encodes its reserve-balance history, so a shuffled sequence is one the strategy could never actually have produced."
      : `Shuffles the fair/price ratio itself, in contiguous ${perm.blockSize}-month blocks (seeded RNG), and reruns the full strategy — calibration, clamps, ledger — from scratch on every shuffle. Valid for every strategy type, including threshold.`;

    const spread = perm.nullP95 - perm.nullP05;
    const binWidth = spread > 0 ? spread / 30 : Math.max(perm.observedBtc * 0.02, 0.0001);
    const bins = Rolling.histogram(Array.from(perm.nullBtc), binWidth);
    Charts.createHistogramChart(el("permutationChart"), bins, perm.observedBtc, { xFormat: (v) => fmtBtc(v), height: 180 });
    el("permutationCaption").textContent =
      `BTC accumulated: the real chronological ordering beat ${fmtNum(perm.percentile, 1)}% of ${perm.nullBtc.length} ` +
      `shuffled ${legacy ? "orderings of the same multipliers" : "signals"} (p ≈ ${fmtNum(perm.pValue, 4)}). Orange marker is the observed result.`;

    const valueSection = el("permutationValueSection");
    if (legacy || perm.nullTotalValue == null) {
      valueSection.hidden = true;
      return;
    }
    valueSection.hidden = false;
    const vSpread = perm.nullP95TotalValue - perm.nullP05TotalValue;
    const vBinWidth = vSpread > 0 ? vSpread / 30 : Math.max(perm.observedTotalValue * 0.02, 0.01);
    const vBins = Rolling.histogram(Array.from(perm.nullTotalValue), vBinWidth);
    Charts.createHistogramChart(el("permutationValueChart"), vBins, perm.observedTotalValue, { xFormat: (v) => fmtUsd(v), height: 180 });
    el("permutationValueCaption").textContent =
      `Total value (BTC + cash left): the real chronological ordering beat ${fmtNum(perm.percentileTotalValue, 1)}% of ` +
      `${perm.nullTotalValue.length} shuffled signals (p ≈ ${fmtNum(perm.pValueTotalValue, 4)}). Orange marker is the observed result.`;
  }

  // Real-vs-shuffled: same multipliers, only the month assignment shuffled.
  // If starved months / invested / deployment rate barely move but BTC does,
  // the edge is genuinely about timing. If they move together, part of the
  // "edge" is the funding constraint interacting differently with a
  // different month ordering, not a timing signal.
  function renderDiagnosticsTable(suite) {
    const r = suite.results[0];
    const legacy = el("legacyPermutationToggle").checked;
    const perm = selectedPermutation(r);
    const rows = [
      ["Starved months", String(perm.observedStarvedMonths), fmtNum(perm.nullMeanStarvedMonths, 1)],
      ["Total invested", fmtUsd(perm.observedInvested), fmtUsd(perm.nullMeanInvested)],
      ["Deployment rate", fmtPct(perm.observedDeploymentRate), fmtPct(perm.nullMeanDeploymentRate)],
      ["BTC accumulated", fmtBtc(perm.observedBtc), fmtBtc(perm.nullMean)],
    ];
    if (!legacy && perm.observedTotalValue != null) {
      rows.push(["Total value", fmtUsd(perm.observedTotalValue), fmtUsd(perm.nullMeanTotalValue)]);
    }
    let html = "<thead><tr><th>Metric</th><th>Real (chronological)</th><th>Shuffled (mean of nulls)</th></tr></thead><tbody>";
    for (const [label, real, shuf] of rows) {
      html += `<tr><td>${label}</td><td data-label="Real">${real}</td><td data-label="Shuffled">${shuf}</td></tr>`;
    }
    html += "</tbody>";
    el("diagnosticsTable").innerHTML = html;

    const dcaBtc = suite.dca.btc;
    el("diagnosticsInterpretation").textContent =
      perm.nullMean >= dcaBtc
        ? `Even the average shuffled run (${fmtBtc(perm.nullMean)} BTC) accumulates at least as much BTC as plain DCA ` +
          `(${fmtBtc(dcaBtc)} BTC) — the multiplier's sheer size, not its timing, is what beats DCA here.`
        : `The average shuffled run (${fmtBtc(perm.nullMean)} BTC) accumulates less BTC than plain DCA ` +
          `(${fmtBtc(dcaBtc)} BTC) — so whatever edge this strategy shows over DCA has to come from timing, since ` +
          `randomizing the timing away erases it.`;
  }

  // ---------------------------------------------------------------------
  // Deployment-ratio sweep (see the "what to run first" workflow in README):
  // under strict funding, sweep targetDeployment 1.0 -> 0.5 for the
  // benchmarked strategy and watch the permutation p-value, not the return.
  // ---------------------------------------------------------------------

  const SWEEP_RATIOS = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];

  function runDeploymentSweep() {
    if (!validateDates()) return;
    readNumericControls();
    const strat = currentBenchmarkStrategy();
    if (strat.strategyType === "threshold") {
      showDataError("The deployment-ratio sweep applies to the power-law strategies (target deployment); the threshold strategy has no such dial.");
      return;
    }

    let context;
    try {
      context = B.prepareFairValueContext(DATA, state.startDate, state.endDate, state.fitMode);
    } catch (err) {
      showDataError(err.message);
      return;
    }
    clearDataError();

    const fundingOpts = {
      fundingMode: state.fundingMode,
      startingCapital: state.startingCapital,
      reserveRateAnnual: state.reserveRateAnnual / 100,
    };

    const rows = SWEEP_RATIOS.map((td) => {
      const params = { p: strat.exponent, mMin: strat.mMin, mMax: strat.mMax, deposit: strat.deposit, targetDeployment: td };
      const series = B.computeMultiplierSeries(DATA, context, params, state.calibration, fundingOpts);
      const perm = Benchmarks.permutationTest(series.prices, series.multipliers, strat.deposit, undefined, undefined, fundingOpts);
      return { targetDeployment: td, pValue: perm.pValue, observedBtc: perm.observedBtc, nullMean: perm.nullMean };
    });

    const base = rows[0].observedBtc;
    for (const r of rows) r.deltaBtcPct = base > 0 ? ((r.observedBtc - base) / base) * 100 : null;

    el("sweepResults").hidden = false;
    renderSweepChart(rows);
    let html =
      "<thead><tr><th>Target deployment</th><th>p-value</th><th>BTC accumulated</th><th>Δ BTC vs. td=1.0</th><th>Null mean BTC</th></tr></thead><tbody>";
    for (const r of rows) {
      html += `<tr>
        <td>${fmtNum(r.targetDeployment, 2)}</td>
        <td data-label="p-value">${fmtNum(r.pValue, 4)}</td>
        <td data-label="BTC accumulated">${fmtBtc(r.observedBtc)}</td>
        <td data-label="Δ BTC vs. td=1.0">${r.deltaBtcPct == null ? "—" : fmtNum(r.deltaBtcPct, 1) + "%"}</td>
        <td data-label="Null mean BTC">${fmtBtc(r.nullMean)}</td>
      </tr>`;
    }
    html += "</tbody>";
    el("sweepTable").innerHTML = html;
  }

  // Minimal hand-rolled line chart (no uPlot dependency — the x-axis here is
  // a dial from 1.0 to 0.5, not a time series, so uPlot's date-scaled x axis
  // doesn't fit). Orange = p-value (left axis, 0-1). Teal = BTC accumulated
  // (right axis, its own min/max range, annotated in the corner).
  function renderSweepChart(rows) {
    const container = el("sweepChart");
    container.innerHTML = "";
    const width = container.clientWidth || 600;
    const height = 220;
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const padL = 46;
    const padR = 46;
    const padT = 16;
    const padB = 28;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const xs = rows.map((r) => r.targetDeployment);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xToPx = (x) => padL + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
    const pToPx = (p) => padT + plotH - p * plotH;
    const btcs = rows.map((r) => r.observedBtc);
    const btcMin = Math.min(...btcs);
    const btcMax = Math.max(...btcs);
    const btcToPx = (b) => padT + plotH - (btcMax === btcMin ? plotH / 2 : ((b - btcMin) / (btcMax - btcMin)) * plotH);

    ctx.strokeStyle = "#2a2c30";
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);

    function drawLine(toPx, color, values) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      rows.forEach((r, i) => {
        const x = xToPx(r.targetDeployment);
        const y = toPx(values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      rows.forEach((r, i) => {
        const x = xToPx(r.targetDeployment);
        const y = toPx(values[i]);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    }
    drawLine(pToPx, COLOR.linear, rows.map((r) => r.pValue));
    drawLine(btcToPx, COLOR.squared, btcs);

    ctx.fillStyle = "#9a9ba0";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    for (const r of rows) ctx.fillText(r.targetDeployment.toFixed(2), xToPx(r.targetDeployment), height - 8);
    ctx.textAlign = "right";
    ctx.fillText("p=1.0", padL - 6, padT + 10);
    ctx.fillText("p=0.0", padL - 6, padT + plotH);
    ctx.textAlign = "left";
    ctx.fillStyle = COLOR.linear;
    ctx.fillText("orange = p-value (left, 0–1)", padL + 4, padT + 12);
    ctx.fillStyle = COLOR.squared;
    ctx.fillText(`teal = BTC accumulated (right, ${fmtBtc(btcMin)}–${fmtBtc(btcMax)})`, padL + 4, padT + 26);
  }

  // ---------------------------------------------------------------------
  // Panel C: rolling windows
  // ---------------------------------------------------------------------

  let rollingDeltaChartInstance = null;

  // Rolling windows always span as much history as is available, independent
  // of whatever period is selected for the main backtest — the point is to
  // see how the result varies across different historical regimes, which a
  // single narrow window can't show.
  function rollingDataBounds() {
    const earliestFeasible = PL.addDays(DATA.startDate, B.MIN_POINTS);
    return { dataStart: B.nextMonthStart(earliestFeasible), dataEnd: dataEndDate() };
  }

  function runRolling() {
    readNumericControls();
    const windowMonths = Number(el("rollingWindowMonths").value);
    const { dataStart, dataEnd } = rollingDataBounds();

    // Every enabled strategy, DCA excluded (rolling computes its own DCA
    // baseline per window above) — reuses buildStrategyDefs() so a strategy
    // enabled here (threshold included, when state.threshold.enabled) is
    // exactly the same strategy the backtest and benchmark panels show,
    // never a second definition that can drift out of sync.
    const strategies = buildStrategyDefs()
      .filter((def) => def.key !== "dca")
      .map((def) => ({
        name: def.label,
        color: def.color,
        exponent: def.p,
        strategyType: def.strategyType,
        threshold: def.threshold,
        mMin: def.mMin,
        mMax: def.mMax,
        targetDeployment: def.targetDeployment,
      }));

    const cfg = {
      windowMonths,
      stepMonths: 1,
      deposit: state.deposit.linear || 500,
      fitMode: state.fitMode,
      calibrate: state.calibration,
      strategies,
      dataStart,
      dataEnd,
    };

    let study;
    try {
      study = Rolling.rollingWindowStudy(cfg);
    } catch (err) {
      showDataError("Rolling window study failed: " + err.message);
      return;
    }
    clearDataError();
    el("rollingResults").hidden = false;
    renderRollingResults(study, cfg);
    lastRollingRun = { study, cfg };
  }

  function binValuesInRange(values, lo, hi, binWidth) {
    const bins = [];
    for (let x = lo; x < hi; x += binWidth) bins.push({ x0: x, x1: x + binWidth, count: 0 });
    if (bins.length === 0) bins.push({ x0: lo, x1: lo + binWidth, count: 0 });
    for (const v of values) {
      let i = Math.floor((v - lo) / binWidth);
      if (i < 0) i = 0;
      if (i >= bins.length) i = bins.length - 1;
      bins[i].count++;
    }
    return bins;
  }

  function renderRollingResults(study, cfg) {
    el("effectiveNNote").textContent =
      `${study.windows.length} overlapping ${cfg.windowMonths}-month windows over ${cfg.dataStart} – ${cfg.dataEnd}, ` +
      `but consecutive windows share almost all their months — only about ${study.effectiveN} are genuinely independent ` +
      `(${study.nonOverlapping.length} non-overlapping windows shown alongside the full set below).`;

    const dates = study.windows.map((w) => w.startDate);
    const series = cfg.strategies.map((s, i) => ({
      label: s.name,
      color: s.color,
      values: study.windows.map((w) => w.strategies[i].deltaBtcPct),
    }));
    rollingDeltaChartInstance = destroyIfExists(rollingDeltaChartInstance);
    rollingDeltaChartInstance = Charts.createTimeSeriesChart(el("deltaVsStartChart"), dates, series, {
      yFormat: (v) => fmtNum(v, 1) + "%",
      hLines: [{ value: 0, label: "0%" }],
    });

    const allDeltas = study.byStrategy.flatMap((s) => s.deltas);
    const lo = Math.min(...allDeltas);
    const hi = Math.max(...allDeltas);
    const binWidth = (hi - lo) / 20 || 0.5;
    const histContainer = el("rollingHistograms");
    histContainer.innerHTML = "";
    // Append every card (and let the CSS grid settle into its final column
    // count) before measuring any chartDiv's width — measuring inside the
    // same loop that's still populating the grid sizes each earlier chart to
    // however many columns existed at that moment, not the final layout.
    const chartDivs = study.byStrategy.map((s, i) => {
      const card = document.createElement("div");
      card.className = "rolling-hist-card";
      const heading = document.createElement("h4");
      heading.style.color = cfg.strategies[i].color;
      heading.textContent = s.name;
      const chartDiv = document.createElement("div");
      card.appendChild(heading);
      card.appendChild(chartDiv);
      histContainer.appendChild(card);
      return chartDiv;
    });
    study.byStrategy.forEach((s, i) => {
      const bins = binValuesInRange(s.deltas, lo, hi, binWidth);
      Charts.createHistogramChart(chartDivs[i], bins, s.mean, { xFormat: (v) => fmtNum(v, 1) + "%", height: 150 });
    });

    let html =
      "<thead><tr><th>Strategy</th><th>n</th><th>Mean</th><th>Median</th><th>SD</th><th>Min</th><th>p05</th><th>p95</th><th>Max</th><th>Win rate</th></tr></thead><tbody>";
    for (const s of study.byStrategy) {
      html += `<tr>
        <td>${s.name}</td>
        <td data-label="n">${s.n}</td>
        <td data-label="Mean">${fmtNum(s.mean, 2)}%</td>
        <td data-label="Median">${fmtNum(s.median, 2)}%</td>
        <td data-label="SD">${fmtNum(s.sd, 2)}%</td>
        <td data-label="Min">${fmtNum(s.min, 2)}%</td>
        <td data-label="p05">${fmtNum(s.p05, 2)}%</td>
        <td data-label="p95">${fmtNum(s.p95, 2)}%</td>
        <td data-label="Max">${fmtNum(s.max, 2)}%</td>
        <td data-label="Win rate">${fmtNum(s.winRate, 1)}%</td>
      </tr>`;
    }
    html += "</tbody>";
    el("rollingSummaryTable").innerHTML = html;

    const parts = study.byStrategy.map((s) => `${s.name.replace(/^\d+\s*·\s*/, "")} win ${fmtNum(s.winRate, 0)}%`);
    el("rollingHeadline").textContent = `${cfg.windowMonths}m · N≈${study.effectiveN} · ${parts.join(" · ")}`;
  }

  // ---------------------------------------------------------------------
  // Mobile copy-to-clipboard summaries: terse, fixed-width plain text,
  // built from exactly the same data already on screen (lastDataCheckReport
  // / lastResults / lastBenchmarkRun / lastRollingRun) so a summary can
  // never say something the panel above it doesn't. Every builder degrades
  // to a one-line "(not yet run)" instead of throwing when its section
  // hasn't been run yet, since Copy-all always calls all four.
  // ---------------------------------------------------------------------

  function shortStrategyCode(label) {
    if (/DCA/i.test(label)) return "DCA";
    if (/linear/i.test(label)) return "PL^1";
    if (/squared/i.test(label)) return "PL^2";
    if (/threshold/i.test(label)) return "THR";
    return label.replace(/^\d+\s*·\s*/, "").slice(0, 6);
  }

  function signedNum(v, decimals) {
    if (v == null || !Number.isFinite(v)) return "—";
    return (v >= 0 ? "+" : "") + fmtNum(v, decimals);
  }

  function buildDataSummaryText() {
    const r = lastDataCheckReport;
    if (!r) return "DATA CHECK\n(not yet run)";
    const h = r.health;
    const lines = ["DATA CHECK"];
    lines.push(`source   ${DATA.source || "unknown"}`);
    lines.push(`range    ${formatDMY(DATA.startDate)} - ${formatDMY(h.lastDate)}  (${h.rows} rows)`);
    lines.push(`last     ${fmtNum(h.lastClose, 0)}`);
    lines.push(`gaps     ${h.gapDays}    zeros ${h.zeroOrNegativeCount}    dups ${fmtNum(r.shape.repeatedClosePct, 1)}%`);
    const ac = r.athCheck;
    lines.push(
      `ATH      ${fmtNum(ac.ath.price, 0)} on ${formatDMY(ac.ath.date)}   ` +
        `[exp ${ac.anchor ? fmtNum(ac.anchor.price, 0) : "—"} +-${ac.anchor ? ac.anchor.tolerancePct : "—"}%]  ${ac.pass ? "PASS" : "FAIL"}`
    );
    if (r.live === undefined) {
      lines.push("live     checking…");
    } else if (r.live === null) {
      lines.push("live     unavailable (network unreachable)");
    } else {
      lines.push(
        `live     ${fmtNum(r.live.medianAbsPct, 1)}% median dev over ${r.live.overlapDays}d           ${r.live.overlapPass ? "PASS" : "FAIL"}`
      );
    }
    lines.push(`vol      ${fmtNum(r.shape.annualVol, 1)}%  [45-75]   ${r.volPass ? "PASS" : "FAIL"}`);
    lines.push(`>5%days  ${fmtNum(r.shape.bigMovePct, 1)}%   [3-5]     ${r.bigMovePass ? "PASS" : "FAIL"}`);
    lines.push(`kurtosis ${fmtNum(r.shape.kurtosis, 1)}    [>5]      ${r.kurtosisPass ? "PASS" : "FAIL"}`);
    const reason = hardFail(r);
    lines.push(`VERDICT  ${reason ? "FAIL — " + reason : "PASS"}`);
    return lines.join("\n");
  }

  function buildBacktestSummaryText() {
    if (!lastResults) return "BACKTEST\n(not yet run)";
    const { strategies, committedMismatch, baseline } = lastResults;
    const codes = strategies.map((s) => shortStrategyCode(s.label));
    const labelW = 12;
    const colW = 9;
    const dataRow = (label, values) => label.padEnd(labelW) + values.map((v) => String(v).padStart(colW)).join("");

    const months = strategies[0].trace.length;
    const deposits = strategies.map((s) => s.deposit);
    const equalDeposits = deposits.every((d) => d === deposits[0]);

    const lines = [];
    lines.push(`BACKTEST  ${formatDMY(state.startDate)} - ${formatDMY(state.endDate)}  (${months} months)`);
    lines.push(`fit ${state.fitMode} | calib ${state.calibration ? "on" : "off"} | funding ${state.fundingMode}`);
    lines.push(equalDeposits ? `deposit ${fmtNum(deposits[0], 0)} all strategies` : "deposit varies by strategy (see table)");
    lines.push("");
    lines.push(" ".repeat(labelW) + codes.map((c) => c.padStart(colW)).join(""));
    lines.push(dataRow("deposited", strategies.map((s) => fmtNum(s.metrics.deposited, 0))));
    lines.push(dataRow("invested", strategies.map((s) => fmtNum(s.metrics.invested, 0))));
    lines.push(dataRow("cash left", strategies.map((s) => fmtNum(s.metrics.cashLeft, 0))));
    lines.push(dataRow("BTC", strategies.map((s) => fmtNum(s.metrics.btcAccumulated, 3))));
    lines.push(dataRow("avg cost", strategies.map((s) => fmtNum(s.metrics.avgCostBasis, 0))));
    lines.push(dataRow("value", strategies.map((s) => fmtNum(s.metrics.totalValue, 0))));
    lines.push(dataRow("XIRR", strategies.map((s) => fmtPct(s.metrics.xirr, 1))));
    lines.push(dataRow("starved", strategies.map((s) => String(s.metrics.starvedMonths))));
    if (!committedMismatch) {
      lines.push(
        dataRow(
          "dBTC vs DCA",
          strategies.map((s) => (s === baseline ? "-" : signedNum(s.comparison.deltaBtcPct, 1) + "%"))
        )
      );
    }
    return lines.join("\n");
  }

  function buildBenchmarkSummaryText() {
    if (!lastBenchmarkRun) return "BENCHMARK\n(not yet run)";
    const { suite, strat } = lastBenchmarkRun;
    const r = suite.results[0];
    const legacy = el("legacyPermutationToggle").checked;
    const perm = selectedPermutation(r);
    const code = shortStrategyCode(strat.name);
    const dcaBtc = suite.dca.btc;
    const nullVsDcaPct = dcaBtc > 0 ? ((perm.nullMean - dcaBtc) / dcaBtc) * 100 : null;

    const lines = ["CEILING / FLOOR"];
    lines.push(`perfect timing   ${signedNum(suite.maxPossibleEdgePct, 1)}% BTC vs DCA`);
    lines.push(`worst timing     ${fmtNum(suite.minPossibleEdgePct, 1)}%`);
    lines.push(`captured  ${code}  ${r.capture == null ? "—" : fmtNum(r.capture * 100, 1) + "%"}`);
    lines.push("");
    lines.push(
      legacy
        ? `PERMUTATION — legacy, multiplier-shuffle, invalid for threshold (${perm.nullBtc.length} shuffles)`
        : `PERMUTATION — signal-shuffle, ${perm.blockSize}mo blocks (${perm.nullBtc.length} shuffles)`
    );
    lines.push("            p      pctile  nullMean vs DCA");
    lines.push(
      `btc   ${code.padEnd(6)}${fmtNum(perm.pValue, 3).padStart(6)}  ${fmtNum(perm.percentile, 1).padStart(8)}  ` +
        `${nullVsDcaPct == null ? "—" : signedNum(nullVsDcaPct, 1) + "%"}`
    );
    if (!legacy && perm.pValueTotalValue != null) {
      lines.push(
        `value ${code.padEnd(6)}${fmtNum(perm.pValueTotalValue, 3).padStart(6)}  ${fmtNum(perm.percentileTotalValue, 1).padStart(8)}`
      );
    }
    lines.push(`real starved ${perm.observedStarvedMonths} | shuffled mean ${fmtNum(perm.nullMeanStarvedMonths, 1)}`);
    lines.push(`real invested ${fmtNum(perm.observedInvested, 0)} | shuffled ${fmtNum(perm.nullMeanInvested, 0)}`);
    return lines.join("\n");
  }

  function buildRollingSummaryText() {
    if (!lastRollingRun) return "ROLLING WINDOWS\n(not yet run)";
    const { study, cfg } = lastRollingRun;
    const lines = [`ROLLING WINDOWS  ${cfg.windowMonths}m`];
    lines.push(`windows ${study.windows.length} | effective N ${study.effectiveN}`);
    lines.push("        mean  med    p05    p95   win%");
    for (const s of study.byStrategy) {
      const code = shortStrategyCode(s.name);
      lines.push(
        `${code.padEnd(8)}${signedNum(s.mean, 1).padStart(5)} ${signedNum(s.median, 1).padStart(5)} ` +
          `${signedNum(s.p05, 1).padStart(6)} ${signedNum(s.p95, 1).padStart(6)}   ${fmtNum(s.winRate, 0)}`
      );
    }
    return lines.join("\n");
  }

  // Timestamp + git short hash (if the deploy set window.APP_COMMIT — this
  // is a static, no-build app, so there's no build step to embed one
  // automatically; omitted rather than faked when absent).
  function buildCopyAllText() {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
    const hashSuffix = window.APP_COMMIT ? ` (${window.APP_COMMIT})` : "";
    return [
      `BTC Power-Law DCA Backtester — ${ts}${hashSuffix}`,
      buildDataSummaryText(),
      buildBacktestSummaryText(),
      buildBenchmarkSummaryText(),
      buildRollingSummaryText(),
    ].join("\n\n");
  }

  window.summary = function () {
    return buildCopyAllText();
  };

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      // Nothing more we can do — the text is at least selected for a manual copy.
    }
    document.body.removeChild(ta);
    done();
  }

  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  function onControlsChanged() {
    if (!validateDates()) {
      lastResults = null;
      renderResultsTable();
      return;
    }
    readNumericControls();
    recompute();
  }

  function wireEvents() {
    ["startDate", "endDate"].forEach((id) => {
      el(id).addEventListener("input", onControlsChanged);
    });
    [
      "fitMode",
      "calibration",
      "fundingMode",
      "startingCapital",
      "reserveRateAnnual",
      "depositDca",
      "depositLinear",
      "depositSquared",
      "depositThreshold",
      "mMinLinear",
      "mMaxLinear",
      "mMinSquared",
      "mMaxSquared",
      "mMinThreshold",
      "mMaxThreshold",
      "targetDeploymentLinear",
      "targetDeploymentSquared",
      "lumpSumDca",
      "lumpSumLinear",
      "lumpSumSquared",
      "lumpSumThreshold",
      "thresholdEnabled",
      "thresholdEnterRatio",
      "thresholdBaseRate",
      "thresholdSpendFraction",
      "thresholdUseBand",
      "thresholdBandSigma",
    ].forEach((id) => {
      el(id).addEventListener("input", onControlsChanged);
      el(id).addEventListener("change", onControlsChanged);
    });
    el("optStrategy").addEventListener("change", () => {
      readNumericControls();
      updateHash();
    });
    el("optObjective").addEventListener("change", () => {
      readNumericControls();
      updateHash();
    });
    el("optTargetDeployment").addEventListener("change", () => {
      readNumericControls();
      updateHash();
    });

    el("valueLogToggle").addEventListener("change", renderValueChart);
    el("legacyPermutationToggle").addEventListener("change", refreshPermutationView);
    el("traceStrategy").addEventListener("change", renderTraceTable);

    el("resetBtn").addEventListener("click", () => {
      state = defaultState();
      applyStateToControls();
      onControlsChanged();
    });

    el("copyLinkBtn").addEventListener("click", () => {
      updateHash();
      const url = location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(() => {});
      }
      const btn = el("copyLinkBtn");
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = original), 1500);
    });

    el("runOptimizerBtn").addEventListener("click", runOptimizer);
    el("runBenchmarkBtn").addEventListener("click", runBenchmarks);
    el("runRollingBtn").addEventListener("click", runRolling);
    el("runSweepBtn").addEventListener("click", runDeploymentSweep);

    el("dataCopyBtn").addEventListener("click", () => copyText(buildDataSummaryText(), el("dataCopyBtn")));
    el("backtestCopyBtn").addEventListener("click", () => copyText(buildBacktestSummaryText(), el("backtestCopyBtn")));
    el("benchmarkCopyBtn").addEventListener("click", () => copyText(buildBenchmarkSummaryText(), el("benchmarkCopyBtn")));
    el("rollingCopyBtn").addEventListener("click", () => copyText(buildRollingSummaryText(), el("rollingCopyBtn")));
    el("copyAllBtn").addEventListener("click", () => copyText(buildCopyAllText(), el("copyAllBtn")));

    el("downloadCsvBtn").addEventListener("click", () => {
      if (!lastResults) return;
      const idx = Number(el("traceStrategy").value);
      const s = lastResults.strategies[idx];
      downloadTextFile(`trace-${s.key}-${state.startDate}-${state.endDate}.csv`, traceToCsv(s.trace), "text/csv");
    });

    window.addEventListener("resize", debounce(() => renderAll(), 200));
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    loadStateFromHash();
    applyStateToControls();
    wireEvents();
    onControlsChanged();
    runDataVerification();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
