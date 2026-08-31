// Chart construction + brush handling, built on vendored uPlot.
// All functions take a plain DOM container and return the uPlot instance
// (or, for the heatmap, a small handle object) so app.js can call .setData/.destroy.
(function (global) {
  "use strict";

  const PL = global.PowerLaw;

  const COLORS = {
    grid: "rgba(255,255,255,0.08)",
    axis: "rgba(230,230,230,0.55)",
    text: "#e8e8e8",
    close: "#e8e8e8",
    fair: "#f7931a", // bitcoin orange
    band: "rgba(247,147,26,0.12)",
  };

  function tsSeconds(dateStr) {
    return Math.floor(PL.parseISODate(dateStr).getTime() / 1000);
  }

  function baseAxisOpts(extra) {
    return Object.assign(
      {
        stroke: COLORS.axis,
        grid: { stroke: COLORS.grid, width: 1 },
        ticks: { stroke: COLORS.grid, width: 1 },
      },
      extra
    );
  }

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- 1. Log-log price chart -------------------------------------------
  //
  // x = days since genesis (log scale), labelled with calendar years.
  // y = price (log scale). Series: close, PL fair value, +/-1 sigma band.
  // Dragging horizontally reports the selected [startDate, endDate] via onRangeSelect.
  function createPriceChart(container, series, onRangeSelect) {
    // series: { days: number[], dates: string[], close: number[], fair: number[], sigma: number }
    const upper = series.fair.map((v) => v * Math.exp(series.sigma));
    const lower = series.fair.map((v) => v * Math.exp(-series.sigma));

    const data = [series.days, series.close, series.fair, upper, lower];

    const opts = {
      width: container.clientWidth || 800,
      height: 360,
      cursor: {
        drag: { x: true, y: false, setScale: false },
      },
      select: { over: true },
      scales: {
        x: { time: false, distr: 3 },
        y: { time: false, distr: 3 },
      },
      bands: [{ series: [3, 4], fill: COLORS.band }],
      series: [
        {},
        { label: "Close", stroke: COLORS.close, width: 1.25, points: { show: false } },
        { label: "Power-law fair value", stroke: COLORS.fair, width: 1.5, points: { show: false } },
        { label: "+1σ", stroke: "rgba(247,147,26,0.35)", width: 1, points: { show: false } },
        { label: "-1σ", stroke: "rgba(247,147,26,0.35)", width: 1, points: { show: false } },
      ],
      axes: [
        baseAxisOpts({
          label: "Year",
          // One tick per Jan-1 boundary (evenly spaced in day-count, i.e. real
          // time), then thin by actual pixel gap ourselves — uPlot's default
          // spacing heuristic assumes evenly-incrementing splits and clusters
          // badly on a log x-axis otherwise.
          splits: (u, axisIdx, scaleMin, scaleMax) => yearSplits(scaleMin, scaleMax),
          values: (u, splits) => splits.map((d) => (d == null ? "" : String(dayToYear(d)))),
          filter: (u, splits) => {
            const minPxGap = 42;
            let lastPx = -Infinity;
            return splits.map((s) => {
              if (s == null) return null;
              const px = u.valToPos(s, "x", true);
              if (px - lastPx < minPxGap) return null;
              lastPx = px;
              return s;
            });
          },
        }),
        baseAxisOpts({ label: "Price (USD)", values: (u, splits) => splits.map(formatAxisPrice) }),
      ],
      hooks: {
        setSelect: [
          (u) => {
            if (!onRangeSelect) return;
            if (u.select.width <= 0) return;
            const leftDay = u.posToVal(u.select.left, "x");
            const rightDay = u.posToVal(u.select.left + u.select.width, "x");
            const startDate = PL.addDays(PL.GENESIS_DATE, Math.round(leftDay));
            const endDate = PL.addDays(PL.GENESIS_DATE, Math.round(rightDay));
            onRangeSelect(startDate, endDate);
          },
        ],
      },
    };

    return new uPlot(opts, data, container);
  }

  function dayToYear(dayCount) {
    const d = PL.addDays(PL.GENESIS_DATE, Math.round(dayCount));
    return d.slice(0, 4);
  }

  function yearSplits(minDay, maxDay) {
    if (!(maxDay > minDay)) return [];
    const startYear = Number(dayToYear(Math.max(1, minDay)));
    const endYear = Number(dayToYear(maxDay)) + 1;
    const out = [];
    for (let y = startYear; y <= endYear; y++) {
      const day = PL.daysSinceGenesis(`${y}-01-01`);
      if (day >= minDay && day <= maxDay) out.push(day);
    }
    return out;
  }

  function formatAxisPrice(v) {
    if (v == null) return "";
    if (v >= 1000) return "$" + Math.round(v / 1000) + "k";
    if (v >= 1) return "$" + Math.round(v);
    return "$" + v.toFixed(2);
  }

  // Re-draws the brush selection rectangle to match externally-set dates
  // (two-way binding: typing in the date inputs redraws the selection).
  function setPriceChartSelection(u, startDate, endDate) {
    const leftDay = PL.daysSinceGenesis(startDate);
    const rightDay = PL.daysSinceGenesis(endDate);
    const left = u.valToPos(leftDay, "x");
    const right = u.valToPos(rightDay, "x");
    u.setSelect({ left: Math.min(left, right), top: 0, width: Math.abs(right - left), height: u.bbox.height / devicePixelRatio }, false);
  }

  // ---- 2/3/4. Generic multi-series time chart ----------------------------
  //
  // Used for portfolio value, reserve balance, and multiplier charts.
  // series: [{ label, color, values: number[] }]
  // hLines (multiplier chart only): [{ value, label }]
  function createTimeSeriesChart(container, dates, seriesList, opts) {
    opts = opts || {};
    const xs = dates.map(tsSeconds);
    const data = [xs, ...seriesList.map((s) => s.values)];

    const uOpts = {
      width: container.clientWidth || 800,
      height: opts.height || 280,
      cursor: { drag: { x: true, y: false } },
      scales: {
        x: { time: true },
        y: { distr: opts.logScale ? 3 : 1 },
      },
      series: [
        {},
        ...seriesList.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 1.5,
          points: { show: false },
        })),
      ],
      axes: [
        baseAxisOpts({}),
        baseAxisOpts({
          values: (u, splits) => splits.map((v) => (v == null ? "" : (opts.yFormat || String)(v))),
        }),
      ],
    };

    if (opts.hLines && opts.hLines.length) {
      uOpts.hooks = {
        draw: [
          (u) => {
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = "rgba(230,230,230,0.35)";
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            for (const hl of opts.hLines) {
              const y = u.valToPos(hl.value, "y", true);
              if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue;
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, y);
              ctx.lineTo(u.bbox.left + u.bbox.width, y);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
      };
    }

    return new uPlot(uOpts, data, container);
  }

  // ---- 5. Optimizer heatmap ----------------------------------------------
  //
  // Not a uPlot chart: rendered as a plain <canvas> grid so cell colour can
  // be driven directly by objective-vs-baseline ratio, with a hover tooltip.
  // cells: [{ mMin, mMax, objectiveValue }], grid axes from Optimizer.generateGrid().
  function createHeatmap(container, cells, baselineValue, mMinValues, mMaxValues, onHover) {
    container.innerHTML = "";
    const canvas = document.createElement("canvas");
    const marginLeft = 44;
    const marginBottom = 26;
    const cssW = Math.max(320, container.clientWidth || 640);
    const plotW = cssW - marginLeft;
    const plotH = Math.round((plotW * mMaxValues.length) / mMinValues.length);
    const cssH = plotH + marginBottom;
    const dpr = reducedMotion ? 1 : window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const cellW = plotW / mMinValues.length;
    const cellH = plotH / mMaxValues.length;

    const byKey = new Map();
    let maxAbsDelta = 0;
    for (const c of cells) {
      const delta = baselineValue ? (c.objectiveValue - baselineValue) / Math.abs(baselineValue) : 0;
      byKey.set(c.mMin + "|" + c.mMax, { ...c, delta });
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta));
    }
    maxAbsDelta = maxAbsDelta || 1;

    function colorFor(delta) {
      const t = Math.max(-1, Math.min(1, delta / maxAbsDelta));
      if (t >= 0) {
        // baseline -> bitcoin orange for positive (beats DCA)
        const g = Math.round(40 + t * 100);
        return `rgb(${Math.round(40 + t * 207)},${g},20)`;
      }
      // desaturated blue for negative (underperforms DCA)
      return `rgb(30,${40 + Math.round(-t * 20)},${60 + Math.round(-t * 120)})`;
    }

    for (let i = 0; i < mMinValues.length; i++) {
      for (let j = 0; j < mMaxValues.length; j++) {
        const mMin = mMinValues[i];
        const mMax = mMaxValues[j];
        const entry = byKey.get(mMin + "|" + mMax);
        ctx.fillStyle = entry ? colorFor(entry.delta) : "rgba(255,255,255,0.03)";
        // mMax increases downward (row j), mMin increases rightward (col i)
        ctx.fillRect(marginLeft + i * cellW, j * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    // Axis labels: mMin along the bottom, mMax along the left. Thinned to
    // avoid overlapping text (every ~4th tick).
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "top";
    const xLabelEvery = Math.ceil((32 / cellW) || 1);
    mMinValues.forEach((v, i) => {
      if (i % xLabelEvery !== 0 && i !== mMinValues.length - 1) return;
      ctx.textAlign = "center";
      ctx.fillText(v.toFixed(2), marginLeft + i * cellW + cellW / 2, plotH + 4);
    });
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    const yLabelEvery = Math.ceil((16 / cellH) || 1);
    mMaxValues.forEach((v, j) => {
      if (j % yLabelEvery !== 0 && j !== mMaxValues.length - 1) return;
      ctx.fillText(v.toFixed(2), marginLeft - 6, j * cellH + cellH / 2);
    });
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("mMin →", marginLeft + plotW / 2, cssH - 2);
    ctx.save();
    ctx.translate(11, plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("mMax →", 0, 0);
    ctx.restore();

    if (onHover) {
      canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left - marginLeft;
        const y = e.clientY - rect.top;
        const i = Math.floor(x / cellW);
        const j = Math.floor(y / cellH);
        const mMin = mMinValues[i];
        const mMax = mMaxValues[j];
        const entry = mMin != null && mMax != null ? byKey.get(mMin + "|" + mMax) : null;
        onHover(entry || null, e.clientX, e.clientY);
      });
      canvas.addEventListener("mouseleave", () => onHover(null, 0, 0));
    }

    return { canvas, byKey };
  }

  // ---- Allocation chart (benchmarks panel) --------------------------------
  //
  // Grey bars: the clairvoyant ceiling allocation. Coloured bars: a
  // strategy's actual monthly spend. Price line overlaid on its own log
  // scale. Shows at a glance whether a strategy bought in roughly the right
  // months and just not hard enough, or in the wrong months entirely.
  function createAllocationChart(container, dates, ceilingSpend, strategySpend, prices, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const canvas = document.createElement("canvas");
    const cssW = Math.max(320, container.clientWidth || 800);
    const cssH = opts.height || 240;
    const dpr = reducedMotion ? 1 : window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const n = dates.length;
    const cellW = cssW / n;
    const maxSpend = Math.max(1, ...ceilingSpend, ...strategySpend);
    const priceLogMin = Math.log(Math.min(...prices));
    const priceLogMax = Math.log(Math.max(...prices));
    const priceRange = priceLogMax - priceLogMin || 1;

    for (let i = 0; i < n; i++) {
      const x = i * cellW;
      const barW = Math.max(1, cellW * 0.8);
      const greyH = (ceilingSpend[i] / maxSpend) * cssH;
      ctx.fillStyle = "rgba(230,230,230,0.18)";
      ctx.fillRect(x + cellW * 0.1, cssH - greyH, barW, greyH);

      const colorH = (strategySpend[i] / maxSpend) * cssH;
      ctx.fillStyle = opts.color || COLORS.fair;
      ctx.fillRect(x + cellW * 0.1 + barW * 0.25, cssH - colorH, barW * 0.5, colorH);
    }

    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1.25;
    for (let i = 0; i < n; i++) {
      const py = cssH - ((Math.log(prices[i]) - priceLogMin) / priceRange) * cssH;
      const px = i * cellW + cellW / 2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    return { canvas };
  }

  // ---- Histogram chart (permutation null / rolling-window deltas) --------
  //
  // Neutral bars for the distribution, an orange marker for the observed
  // value — the marker is the point of the chart, the bars are context.
  function createHistogramChart(container, bins, markerValue, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const canvas = document.createElement("canvas");
    const marginBottom = 22;
    const cssW = Math.max(240, container.clientWidth || 400);
    const cssH = opts.height || 180;
    const plotH = cssH - marginBottom;
    const dpr = reducedMotion ? 1 : window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    if (bins.length === 0) return { canvas };
    const maxCount = Math.max(1, ...bins.map((b) => b.count));
    const lo = bins[0].x0;
    const hi = bins[bins.length - 1].x1;
    const range = hi - lo || 1;
    const cellW = cssW / bins.length;

    bins.forEach((b, i) => {
      const h = (b.count / maxCount) * plotH;
      ctx.fillStyle = "rgba(122,139,166,0.55)";
      ctx.fillRect(i * cellW + 1, plotH - h, Math.max(1, cellW - 2), h);
    });

    ctx.fillStyle = COLORS.text;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText((opts.xFormat || String)(lo), 0, plotH + 4);
    ctx.textAlign = "right";
    ctx.fillText((opts.xFormat || String)(hi), cssW, plotH + 4);

    if (markerValue != null && markerValue >= lo && markerValue <= hi) {
      const mx = ((markerValue - lo) / range) * cssW;
      ctx.beginPath();
      ctx.strokeStyle = COLORS.fair;
      ctx.lineWidth = 2;
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, plotH);
      ctx.stroke();
    }

    return { canvas };
  }

  global.Charts = {
    createPriceChart,
    setPriceChartSelection,
    createTimeSeriesChart,
    createHeatmap,
    createAllocationChart,
    createHistogramChart,
    tsSeconds,
    COLORS,
  };
})(typeof window !== "undefined" ? window : globalThis);
