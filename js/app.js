// Wiring: state, controls, rendering, URL hash persistence.
(function () {
  "use strict";

  const PL = window.PowerLaw;
  const B = window.Backtest;
  const DATA = window.BTC_DATA;

  const COLOR = { dca: "#7a8ba6", linear: "#f7931a", squared: "#4fb3a9" };

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
      deposit: { dca: 500, linear: 500, squared: 500 },
      bounds: {
        linear: { mMin: 0.0, mMax: 3.0 },
        squared: { mMin: 0.0, mMax: 3.0 },
      },
      optimizer: { strategy: "linear", objective: "btcAccumulated" },
    };
  }

  let state = defaultState();
  let lastResults = null; // populated by recompute()
  let priceChartInstance = null;
  let valueChartInstance = null;
  let reserveChartInstance = null;
  let multiplierChartInstance = null;

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
      return Object.assign(defaultState(), parsed, {
        deposit: Object.assign(defaultState().deposit, parsed.deposit),
        bounds: {
          linear: Object.assign(defaultState().bounds.linear, parsed.bounds && parsed.bounds.linear),
          squared: Object.assign(defaultState().bounds.squared, parsed.bounds && parsed.bounds.squared),
        },
        optimizer: Object.assign(defaultState().optimizer, parsed.optimizer),
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
    el("depositDca").value = state.deposit.dca;
    el("depositLinear").value = state.deposit.linear;
    el("depositSquared").value = state.deposit.squared;
    el("mMinLinear").value = state.bounds.linear.mMin;
    el("mMaxLinear").value = state.bounds.linear.mMax;
    el("mMinSquared").value = state.bounds.squared.mMin;
    el("mMaxSquared").value = state.bounds.squared.mMax;
    el("optStrategy").value = state.optimizer.strategy === "squared" ? "2" : "1";
    el("optObjective").value = state.optimizer.objective;
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

  function readNumericControls() {
    state.fitMode = el("fitMode").value;
    state.calibration = el("calibration").checked;
    state.deposit.dca = Math.max(0, Number(el("depositDca").value) || 0);
    state.deposit.linear = Math.max(0, Number(el("depositLinear").value) || 0);
    state.deposit.squared = Math.max(0, Number(el("depositSquared").value) || 0);

    let mMinL = Number(el("mMinLinear").value);
    let mMaxL = Number(el("mMaxLinear").value);
    if (!Number.isFinite(mMinL)) mMinL = 0;
    if (!Number.isFinite(mMaxL)) mMaxL = mMinL;
    if (mMinL > mMaxL) [mMinL, mMaxL] = [mMaxL, mMinL];
    state.bounds.linear = { mMin: mMinL, mMax: mMaxL };

    let mMinS = Number(el("mMinSquared").value);
    let mMaxS = Number(el("mMaxSquared").value);
    if (!Number.isFinite(mMinS)) mMinS = 0;
    if (!Number.isFinite(mMaxS)) mMaxS = mMinS;
    if (mMinS > mMaxS) [mMinS, mMaxS] = [mMaxS, mMinS];
    state.bounds.squared = { mMin: mMinS, mMax: mMaxS };

    state.optimizer.strategy = el("optStrategy").value === "2" ? "squared" : "linear";
    state.optimizer.objective = el("optObjective").value;
  }

  // ---------------------------------------------------------------------
  // Core compute
  // ---------------------------------------------------------------------

  function buildStrategyDefs() {
    return [
      { key: "dca", label: "1 · DCA", color: COLOR.dca, p: 0, deposit: state.deposit.dca, mMin: 0, mMax: 1e9 },
      {
        key: "linear",
        label: "2 · Power-law linear",
        color: COLOR.linear,
        p: 1,
        deposit: state.deposit.linear,
        mMin: state.bounds.linear.mMin,
        mMax: state.bounds.linear.mMax,
      },
      {
        key: "squared",
        label: "3 · Power-law squared",
        color: COLOR.squared,
        p: 2,
        deposit: state.deposit.squared,
        mMin: state.bounds.squared.mMin,
        mMax: state.bounds.squared.mMax,
      },
    ];
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

    const defs = buildStrategyDefs();
    const strategies = defs.map((def) => {
      const { trace, kMin, kMax } = B.runLedger(
        DATA,
        context,
        { p: def.p, mMin: def.mMin, mMax: def.mMax, deposit: def.deposit, startingBalance: 0 },
        state.calibration
      );
      const metrics = B.computeMetrics(DATA, trace, def.deposit, state.endDate);
      return { ...def, trace, metrics, kMin, kMax };
    });

    const baseline = strategies[0];
    for (const s of strategies) {
      s.comparison = B.compareToBaseline(s.metrics, baseline.metrics);
    }

    lastResults = { context, strategies, baseline };
    updateHash();
    renderAll();
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function renderAll() {
    renderResultsTable();
    renderPriceChart();
    renderValueChart();
    renderReserveChart();
    renderMultiplierChart();
    renderTraceTable();
  }

  function metricRow(label, cells) {
    return `<tr><td>${label}</td>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  }

  function renderResultsTable() {
    const table = el("resultsTable");
    if (!lastResults) {
      table.innerHTML = "";
      return;
    }
    const { strategies } = lastResults;

    const deposits = strategies.map((s) => s.deposit);
    const equalDeposits = deposits.every((d) => d === deposits[0]);
    el("unequalDepositsHint").hidden = equalDeposits;

    let html = `<thead><tr><th>Metric</th>${strategies.map((s) => `<th style="color:${s.color}">${s.label}</th>`).join("")}</tr></thead><tbody>`;

    html += metricRow("Total deposited", strategies.map((s) => fmtUsd(s.metrics.deposited)));
    html += metricRow("Total invested", strategies.map((s) => fmtUsd(s.metrics.invested)));
    html += metricRow("Deployment rate", strategies.map((s) => fmtPct(s.metrics.deploymentRate)));
    html += metricRow("Cash left", strategies.map((s) => fmtUsd(s.metrics.cashLeft)));
    html += metricRow("BTC accumulated", strategies.map((s) => fmtBtc(s.metrics.btcAccumulated)));
    html += metricRow("Average cost basis", strategies.map((s) => fmtUsd(s.metrics.avgCostBasis)));
    html += metricRow("BTC value at end", strategies.map((s) => fmtUsd(s.metrics.btcValue)));
    html += metricRow("Total value", strategies.map((s) => fmtUsd(s.metrics.totalValue)));
    html += metricRow("MoIC (on invested)", strategies.map((s) => fmtX(s.metrics.moicOnInvested)));
    html += metricRow("MoIC (on deposited)", strategies.map((s) => fmtX(s.metrics.moicOnDeposited)));
    html += metricRow("XIRR", strategies.map((s) => fmtPct(s.metrics.xirr)));
    html += metricRow(
      "Starved months",
      strategies.map((s) => `${s.metrics.starvedMonths} (${fmtPct(s.metrics.starvedMonthsPct, 1)})`)
    );
    html += metricRow(
      "Unmet demand",
      strategies.map((s) => `${fmtUsd(s.metrics.unmetDemand)} (${fmtPct(s.metrics.unmetDemandPct, 1)})`)
    );
    html += metricRow("Reserve max", strategies.map((s) => fmtUsd(s.metrics.reserveMax)));
    html += metricRow("Reserve mean", strategies.map((s) => fmtUsd(s.metrics.reserveMean)));
    html += metricRow("Reserve months at zero", strategies.map((s) => String(s.metrics.reserveMonthsAtZero)));
    if (state.calibration) {
      html += metricRow(
        "k used (range)",
        strategies.map((s) => (s.p === 0 ? "1.000" : `${fmtNum(s.kMin, 3)} – ${fmtNum(s.kMax, 3)}`))
      );
    }

    html += `<tr><td colspan="${strategies.length + 1}" style="padding-top:0.9rem; color:var(--muted); font-family:var(--sans); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.04em;">vs. strategy 1 (DCA baseline)</td></tr>`;
    html += metricRow(
      "Δ BTC accumulated",
      strategies.map((s) => (s === lastResults.baseline ? "—" : fmtPct(s.comparison.deltaBtcPct)))
    );
    html += metricRow(
      "Δ total value",
      strategies.map((s) =>
        s === lastResults.baseline ? "—" : `${fmtUsd(s.comparison.deltaTotalValue)} (${fmtPct(s.comparison.deltaTotalValuePct)})`
      )
    );
    html += metricRow(
      "Δ XIRR",
      strategies.map((s) =>
        s === lastResults.baseline
          ? "—"
          : s.comparison.deltaXirrPts == null
          ? "—"
          : (s.comparison.deltaXirrPts >= 0 ? "+" : "") + fmtNum(s.comparison.deltaXirrPts * 100, 2) + " pp"
      )
    );

    html += "</tbody>";
    table.innerHTML = html;
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

    const strategyKey = state.optimizer.strategy;
    const p = strategyKey === "squared" ? 2 : 1;
    const opts = {
      p,
      startDate: state.startDate,
      endDate: state.endDate,
      deposit: state.deposit[strategyKey],
      startingBalance: 0,
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
        <td>${fmtNum(c.mMin, 2)}</td>
        <td>${fmtNum(c.mMax, 2)}</td>
        <td>${formatObjective(c.objectiveValue, opts.objective)}</td>
        <td>${fmtPct(cmp.deltaBtcPct)}</td>
        <td>${fmtUsd(c.metrics.totalValue)}</td>
        <td>${fmtPct(c.metrics.xirr)}</td>
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
      "depositDca",
      "depositLinear",
      "depositSquared",
      "mMinLinear",
      "mMaxLinear",
      "mMinSquared",
      "mMaxSquared",
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

    el("valueLogToggle").addEventListener("change", renderValueChart);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
