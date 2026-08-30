// Correctness checks (spec section 9). Plain assertions, no framework, DOM-free
// so the same logic can be exercised from tests.html or from Node.
(function (global) {
  "use strict";

  const PL = global.PowerLaw;
  const B = global.Backtest;

  function approxEqual(a, b, tol) {
    return Math.abs(a - b) <= tol;
  }

  // Deterministic PRNG (mulberry32) so the power-law recovery test is reproducible.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    // Box-Muller
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function makeFlatSeriesData(price, days, startDate) {
    startDate = startDate || "2010-07-18";
    days = Math.max(days, 3700); // cover fixture date ranges used below (into 2019-12)
    return { startDate, closes: new Array(days).fill(price) };
  }

  // Builds a minimal fair-value context for a flat/synthetic series without
  // requiring the 1500-point expanding-fit minimum (uses 'full' mode).
  function contextFor(data, startDate, endDate) {
    return B.prepareFairValueContext(data, startDate, endDate, "full");
  }

  function runAllTests() {
    const results = [];
    const check = (name, fn) => {
      try {
        fn((cond, detail) => {
          if (!cond) throw new Error(detail || "assertion failed");
        });
        results.push({ name, pass: true });
      } catch (err) {
        results.push({ name, pass: false, message: err.message });
      }
    };

    // 1. Constant price: DCA, deposit 100 x 12 months on a flat 100 series -> 12 BTC.
    check("1. Constant price -> exact BTC count", (assert) => {
      const data = makeFlatSeriesData(100, 3000, "2010-07-18");
      const ctx = contextFor(data, "2018-01-01", "2018-12-01");
      const { trace } = B.runLedger(data, ctx, { p: 0, mMin: 0, mMax: 3, deposit: 100, startingBalance: 0 }, false);
      assert(trace.length === 12, `expected 12 months, got ${trace.length}`);
      const btc = trace[trace.length - 1].btc;
      assert(approxEqual(btc, 12, 1e-9), `expected 12 BTC, got ${btc}`);
      const invested = trace.reduce((s, r) => s + r.spend, 0);
      assert(approxEqual(invested, 1200, 1e-9), `expected invested 1200, got ${invested}`);
      assert(approxEqual(trace[trace.length - 1].balance, 0, 1e-9), "expected 0 cash left");
    });

    // 2. Degenerate multiplier: mMin = mMax = 1 on strategies 2 & 3 -> identical to strategy 1.
    check("2. mMin=mMax=1 matches DCA", (assert) => {
      const data = makeFlatSeriesData(100, 3000, "2010-07-18");
      // Give the series some variation so PL fair value / ratio isn't trivially 1.
      for (let i = 0; i < data.closes.length; i++) data.closes[i] = 100 * (1 + 0.3 * Math.sin(i / 37));
      const ctx = contextFor(data, "2018-01-01", "2019-12-01");
      const dca = B.runLedger(data, ctx, { p: 0, mMin: 0, mMax: 3, deposit: 250, startingBalance: 0 }, true).trace;
      for (const p of [1, 2]) {
        const pow = B.runLedger(data, ctx, { p, mMin: 1, mMax: 1, deposit: 250, startingBalance: 0 }, true).trace;
        for (let i = 0; i < dca.length; i++) {
          assert(
            approxEqual(pow[i].spend, dca[i].spend, 1e-6),
            `p=${p} month ${i}: spend ${pow[i].spend} != DCA spend ${dca[i].spend}`
          );
          assert(approxEqual(pow[i].btc, dca[i].btc, 1e-9), `p=${p} month ${i}: btc mismatch`);
        }
      }
    });

    // 3. Exponent zero: p=0 -> identical to DCA regardless of boundaries.
    check("3. p=0 matches DCA regardless of boundaries", (assert) => {
      const data = makeFlatSeriesData(100, 3000, "2010-07-18");
      for (let i = 0; i < data.closes.length; i++) data.closes[i] = 100 * (1 + 0.5 * Math.sin(i / 21));
      const ctx = contextFor(data, "2018-01-01", "2019-12-01");
      const dca = B.runLedger(data, ctx, { p: 0, mMin: 0, mMax: 3, deposit: 300, startingBalance: 0 }, true).trace;
      for (const bounds of [
        { mMin: 0, mMax: 3 },
        { mMin: 0.2, mMax: 5 },
        { mMin: 0, mMax: 8 },
      ]) {
        const other = B.runLedger(
          data,
          ctx,
          { p: 0, mMin: bounds.mMin, mMax: bounds.mMax, deposit: 300, startingBalance: 0 },
          true
        ).trace;
        for (let i = 0; i < dca.length; i++) {
          assert(
            approxEqual(other[i].spend, dca[i].spend, 1e-6),
            `bounds ${JSON.stringify(bounds)} month ${i}: spend mismatch`
          );
        }
      }
    });

    // 4. Ledger conservation: deposited == invested + balance on every row, every strategy.
    check("4. Ledger conservation holds every month, every strategy", (assert) => {
      const data = global.BTC_DATA;
      const ctx = B.prepareFairValueContext(data, "2018-01-01", "2022-12-01", "expanding");
      for (const params of [
        { p: 0, mMin: 0, mMax: 3, deposit: 500, startingBalance: 0 },
        { p: 1, mMin: 0, mMax: 3, deposit: 500, startingBalance: 0 },
        { p: 2, mMin: 0, mMax: 3, deposit: 500, startingBalance: 0 },
      ]) {
        const { trace } = B.runLedger(data, ctx, params, true);
        let runningDeposited = 0;
        let runningInvested = 0;
        for (const row of trace) {
          runningDeposited += params.deposit;
          runningInvested += row.spend;
          assert(
            approxEqual(runningDeposited, runningInvested + row.balance, 1e-6),
            `p=${params.p} ${row.date}: deposited ${runningDeposited} != invested ${runningInvested} + balance ${row.balance}`
          );
        }
      }
    });

    // 5. Power-law recovery: synthetic series from known A, n + small noise.
    check("5. Power-law fit recovers known A, n within 1%", (assert) => {
      const trueA = 2.3e-11;
      const trueN = 5.8;
      const rand = mulberry32(12345);
      const startDate = "2015-01-01";
      const nDays = 4000;
      const closes = new Array(nDays);
      const startD = PL.daysSinceGenesis(startDate);
      for (let i = 0; i < nDays; i++) {
        const d = startD + i;
        const noise = 1 + 0.003 * gaussian(rand); // ~0.3% multiplicative noise
        closes[i] = trueA * Math.pow(d, trueN) * noise;
      }
      const data = { startDate, closes };
      const endDate = PL.addDays(startDate, nDays - 1);
      const fit = PL.fitPowerLaw(data, startDate, endDate);
      const errA = Math.abs(fit.A - trueA) / trueA;
      const errN = Math.abs(fit.n - trueN) / Math.abs(trueN);
      assert(errA < 0.01, `A error ${(errA * 100).toFixed(3)}% exceeds 1% (fit=${fit.A}, true=${trueA})`);
      assert(errN < 0.01, `n error ${(errN * 100).toFixed(3)}% exceeds 1% (fit=${fit.n}, true=${trueN})`);
    });

    // 6. No lookahead: in expanding mode, fitEnd < purchaseDate for every month.
    check("6. Expanding mode never looks ahead", (assert) => {
      const data = global.BTC_DATA;
      const ctx = B.prepareFairValueContext(data, "2018-01-01", "2024-12-01", "expanding");
      for (const t of ctx.purchaseDates) {
        const row = ctx.plFairByDate.get(t);
        assert(row.fit.fitEnd < t, `fitEnd ${row.fit.fitEnd} not before purchase date ${t}`);
      }
      assert(ctx.purchaseDates.length > 0, "no purchase dates generated");
    });

    // 7. XIRR sanity: 1000 -> 2000 over exactly one year (365 days, non-leap) -> 100% +/- 0.1pp.
    check("7. XIRR sanity check", (assert) => {
      const xirr = B.computeXIRR([
        { date: "2019-01-01", amount: -1000 },
        { date: "2020-01-01", amount: 2000 },
      ]);
      assert(xirr != null, "XIRR failed to converge");
      assert(approxEqual(xirr, 1.0, 0.001), `expected XIRR ~100%, got ${(xirr * 100).toFixed(3)}%`);
    });

    return results;
  }

  global.TestsCore = { runAllTests };
})(typeof window !== "undefined" ? window : globalThis);
