// Correctness checks (spec section 9). Plain assertions, no framework, DOM-free
// so the same logic can be exercised from tests.html or from Node.
(function (global) {
  "use strict";

  const PL = global.PowerLaw;
  const B = global.Backtest;
  const BM = global.Benchmarks;
  const R = global.Rolling;

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

    // 8. Shared ledger: Backtest.runLedger's DCA path and Benchmarks.simulateLedger
    // must agree exactly — that agreement is the whole point of routing runLedger
    // through simulateLedger instead of keeping a second copy of the loop.
    check("8. runLedger and simulateLedger agree on plain DCA", (assert) => {
      const data = global.BTC_DATA;
      const ctx = B.prepareFairValueContext(data, "2018-01-01", "2022-12-01", "expanding");
      const { trace } = B.runLedger(data, ctx, { p: 0, mMin: 0, mMax: 1e9, deposit: 500, startingBalance: 0 }, false);

      const dates = BM.monthStarts("2018-01-01", "2022-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const ones = new Float64Array(prices.length).fill(1);
      const direct = BM.simulateLedger(prices, ones, 500);

      const last = trace[trace.length - 1];
      assert(approxEqual(last.btc, direct.btc, 1e-9), `btc mismatch: runLedger=${last.btc} simulateLedger=${direct.btc}`);
      assert(approxEqual(last.balance, direct.cashLeft, 1e-9), `cashLeft mismatch: runLedger=${last.balance} simulateLedger=${direct.cashLeft}`);
    });

    // 9. simulateLedger's debug mode (the ledger-conservation assertion
    // INTEGRATION.md asked for) doesn't false-positive on an ordinary run,
    // including with a non-zero starting balance.
    check("9. simulateLedger debug mode passes on a normal run", (assert) => {
      const data = global.BTC_DATA;
      const dates = BM.monthStarts("2018-01-01", "2020-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const mult = Float64Array.from(prices, () => 1.5);
      let threw = false;
      try {
        BM.simulateLedger(prices, mult, 500, { debug: true, startingBalance: 1000 });
      } catch (e) {
        threw = true;
      }
      assert(!threw, "debug assertion false-positived on a conserving ledger");
    });

    // 10. Ceiling >= DCA >= floor for any real price series: the clairvoyant
    // best-case can never do worse than DCA, and the worst-case can never do
    // better, because DCA is one particular (non-adaptive) allocation and
    // ceiling/floor are the extremes over ALL allocations under the same
    // deposit-can-only-be-spent-later constraint.
    check("10. Perfect-timing ceiling/floor bracket DCA", (assert) => {
      const dates = BM.monthStarts("2018-01-01", "2022-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const ones = new Float64Array(prices.length).fill(1);
      const dca = BM.simulateLedger(prices, ones, 500);
      const ceiling = BM.perfectTiming(prices, 500, "best");
      const floor = BM.perfectTiming(prices, 500, "worst");
      assert(ceiling.btc >= dca.btc - 1e-9, `ceiling ${ceiling.btc} should be >= DCA ${dca.btc}`);
      assert(dca.btc >= floor.btc - 1e-9, `DCA ${dca.btc} should be >= floor ${floor.btc}`);
    });

    // 11. Permutation test degenerate case: shuffling a constant multiplier
    // array changes nothing, so every shuffled replicate ties the observed
    // result exactly. That means the "real" ordering never beats a shuffled
    // one — the correct, honest p-value is 1 (no significance whatsoever),
    // which is exactly right: a constant multiplier carries no timing
    // information for the test to detect.
    check("11. Permutation test reports no significance for a constant (untimed) strategy", (assert) => {
      const dates = BM.monthStarts("2018-01-01", "2020-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const ones = new Float64Array(prices.length).fill(1);
      const perm = BM.permutationTest(prices, ones, 500, 500, BM.mulberry32(7));
      assert(perm.pValue === 1, `expected p=1 for an unshuffleable series, got ${perm.pValue}`);
      assert(perm.nullSd < 1e-9, `expected a near-zero-spread null distribution, got sd=${perm.nullSd}`);
    });

    // 12. calibrationConstant at exponent 0 is always 1, matching the same
    // "p=0 behaves like DCA regardless of everything else" identity checked
    // for the main ledger in test 3.
    check("12. calibrationConstant(exponent=0) is always 1", (assert) => {
      const fair = [100, 200, 50, 9999];
      const prices = [10, 20, 5, 1];
      const k = BM.calibrationConstant(fair, prices, 0, []);
      assert(k === 1, `expected k=1 for exponent 0, got ${k}`);
    });

    // 13. Rolling-window study refuses a period shorter than the window
    // instead of silently producing NaN summary statistics.
    check("13. rollingWindowStudy rejects a too-short period", (assert) => {
      let threw = false;
      let message = "";
      try {
        R.rollingWindowStudy({
          windowMonths: 48,
          deposit: 500,
          fitMode: "full",
          calibrate: false,
          strategies: [{ name: "Linear", exponent: 1, mMin: 0, mMax: 3 }],
          dataStart: "2020-01-01",
          dataEnd: "2021-06-01",
        });
      } catch (e) {
        threw = true;
        message = e.message;
      }
      assert(threw, "expected rollingWindowStudy to throw for a too-short period");
      assert(/shorter than the rolling window/.test(message), `unexpected error message: ${message}`);
    });

    // 14. DataCheck.checkAnchors: an exact in-range match passes, and a date
    // beyond the committed series is reported as such rather than crashing
    // or silently comparing against undefined.
    check("14. DataCheck anchors: in-range match passes, out-of-range date reports so", (assert) => {
      const closes = new Array(10).fill(1);
      closes[6] = 126200; // startDate + 6 days = 2025-10-07, exact match to the ATH anchor
      const data = { startDate: "2025-10-01", closes };
      const results = global.DataCheck.checkAnchors(data);
      assert(results[0].pass === true, `expected the in-range anchor to pass, devPct=${results[0].devPct}`);
      assert(
        results[1].pass === false && results[1].local === null,
        "expected the out-of-range anchor to report null/fail rather than compare against undefined"
      );
    });

    // 15. shapeDiagnostics computes a real kurtosis, not a fixed number: an
    // i.i.d.-Gaussian synthetic series should land near 3 (the diagnostic's
    // own "this looks synthetic" threshold), well below the ~24 the real
    // committed BTC series shows.
    check("15. shapeDiagnostics distinguishes near-normal synthetic data from fat tails", (assert) => {
      const rand = mulberry32(99);
      const n = 2000;
      const closes = [1000];
      for (let i = 1; i < n; i++) closes.push(closes[i - 1] * Math.exp(0.001 * gaussian(rand)));
      const shape = global.DataCheck.shapeDiagnostics({ startDate: "2015-01-01", closes });
      assert(shape.kurtosis < 6, `expected near-normal kurtosis (~3) for i.i.d. Gaussian returns, got ${shape.kurtosis}`);
    });

    // 16. targetDeployment generalizes the calibration identity: the median
    // of k * ratio^p lands on targetDeployment, not just on 1 — this is how
    // a reduced-deployment strategy is expressed (never as a smaller
    // deposit).
    check("16. calibrationConstant median identity generalizes to targetDeployment", (assert) => {
      const fair = [50, 80, 120, 30, 200, 60, 90, 110, 40, 70];
      const prices = new Array(10).fill(100);
      for (const td of [1, 0.7, 0.5]) {
        const exponent = 1;
        const k = BM.calibrationConstant(fair, prices, exponent, null, td);
        const scaled = fair.map((f, i) => k * Math.pow(f / prices[i], exponent)).sort((a, b) => a - b);
        const mid = Math.floor(scaled.length / 2);
        const med = scaled.length % 2 === 0 ? (scaled[mid - 1] + scaled[mid]) / 2 : scaled[mid];
        assert(approxEqual(med, td, 1e-9), `targetDeployment=${td}: expected median ${td}, got ${med}`);
      }
    });

    // 17. lumpSumAtStart changes WHEN starting capital is deployed (t0 vs.
    // held as reserve), never HOW MUCH was committed — totalCommitted must
    // match either way, and ledger conservation (invested + cashLeft ==
    // totalCommitted) must hold in both cases.
    check("17. lumpSumAtStart: same totalCommitted, different deployment timing", (assert) => {
      const data = global.BTC_DATA;
      const ctx = B.prepareFairValueContext(data, "2018-01-01", "2020-12-01", "expanding");
      const base = { p: 2, mMin: 0, mMax: 4, deposit: 100, targetDeployment: 1, fundingMode: "seeded", startingCapital: 5000 };
      const lump = B.runLedger(data, ctx, { ...base, lumpSumAtStart: true }, true);
      const reserve = B.runLedger(data, ctx, { ...base, lumpSumAtStart: false }, true);
      const mLump = B.computeMetrics(data, lump.trace, base.deposit, "2020-12-01", {
        ledgerResult: lump.result,
        startingCapital: base.startingCapital,
      });
      const mReserve = B.computeMetrics(data, reserve.trace, base.deposit, "2020-12-01", {
        ledgerResult: reserve.result,
        startingCapital: base.startingCapital,
      });
      assert(
        approxEqual(mLump.totalCommitted, mReserve.totalCommitted, 1e-6),
        `totalCommitted should match regardless of lumpSumAtStart: lump=${mLump.totalCommitted} reserve=${mReserve.totalCommitted}`
      );
      assert(
        approxEqual(mLump.invested + mLump.cashLeft, mLump.totalCommitted, 1e-6),
        `lump-sum conservation broken: invested+cashLeft=${mLump.invested + mLump.cashLeft} != totalCommitted=${mLump.totalCommitted}`
      );
      assert(
        approxEqual(mReserve.invested + mReserve.cashLeft, mReserve.totalCommitted, 1e-6),
        `held-reserve conservation broken: invested+cashLeft=${mReserve.invested + mReserve.cashLeft} != totalCommitted=${mReserve.totalCommitted}`
      );
      assert(
        mLump.invested > mReserve.invested,
        `lump-sum should convert more of the same committed capital to BTC immediately: lump invested=${mLump.invested} reserve invested=${mReserve.invested}`
      );
    });

    // 18. Threshold strategy shape: below enterThreshold it buys baseRate x
    // deposit (builds reserve); at/above it, it buys deposit plus
    // reserveSpendFraction x balance. Worked by hand on a 2-month synthetic
    // series (see the comment inline) so the expected multipliers are exact.
    check("18. Threshold strategy buys baseRate below threshold, reserve fraction at/above", (assert) => {
      const prices = [100, 100];
      const fair = [50, 200]; // ratio fair/price = 0.5 (below), then 2.0 (above)
      const deposit = 100;
      const params = { enterThreshold: 1.0, baseRate: 0.6, reserveSpendFraction: 0.25, mMin: 0, mMax: 10 };
      const mult = BM.computeThresholdMultiplierArray(prices, fair, deposit, params, { fundingMode: "strict" });
      // t=0: balance 0 -> +100 deposit -> 100. ratio 0.5 < 1.0 -> desired = 100*0.6 = 60 -> m=0.6.
      //      spend = min(60, 100) = 60 -> balance -> 40.
      assert(approxEqual(mult[0], 0.6, 1e-9), `month 0: expected m=0.6 (baseRate), got ${mult[0]}`);
      // t=1: balance 40 -> +100 deposit -> 140. ratio 2.0 >= 1.0 ->
      //      desired = 100 + 0.25*140 = 135 -> m=1.35.
      assert(approxEqual(mult[1], 1.35, 1e-9), `month 1: expected m=1.35 (reserve fraction), got ${mult[1]}`);
    });

    // 19. Unbound funding can go into debt (negative balance) to fully fund
    // every desired purchase; strict/seeded never do — the balance floor at
    // 0 (strict) or startingCapital-bounded-below (seeded, never negative
    // either) is exactly what makes them runnable strategies and unbound a
    // diagnostic only.
    check("19. Unbound funding goes negative under heavy demand; strict/seeded never do", (assert) => {
      const prices = [100, 100, 100];
      const mult = [5, 5, 5]; // desired = 5x deposit, far more than any funding mode can sustainably cover
      const deposit = 100;
      const strict = BM.simulateLedger(prices, mult, deposit, { fundingMode: "strict" });
      const seeded = BM.simulateLedger(prices, mult, deposit, { fundingMode: "seeded", startingCapital: 50 });
      const unbound = BM.simulateLedger(prices, mult, deposit, { fundingMode: "unbound", startingCapital: 50 });
      assert(strict.cashLeft >= -1e-9, `strict balance went negative: ${strict.cashLeft}`);
      assert(seeded.cashLeft >= -1e-9, `seeded balance went negative: ${seeded.cashLeft}`);
      assert(unbound.cashLeft < 0, `expected unbound to run into debt (negative balance), got ${unbound.cashLeft}`);
      assert(unbound.starvedMonths === 0, `unbound should never be starved (spend=desired unconditionally), got ${unbound.starvedMonths}`);
      assert(strict.starvedMonths > 0, `strict should be starved under demand this far beyond deposit, got ${strict.starvedMonths}`);
    });

    // 20. computeMetrics: totalCommitted includes startingCapital, and the
    // XIRR t0 outflow actually reflects it (not just the deposit stream) —
    // comparing against startingCapital=0 on the SAME trace isolates the
    // effect of the t0 outflow itself.
    check("20. computeMetrics folds startingCapital into totalCommitted and the XIRR t0 outflow", (assert) => {
      const data = global.BTC_DATA;
      const ctx = B.prepareFairValueContext(data, "2019-01-01", "2020-12-01", "expanding");
      const params = { p: 0, mMin: 0, mMax: 3, deposit: 100, fundingMode: "seeded", startingCapital: 1000, lumpSumAtStart: true };
      const { trace, result } = B.runLedger(data, ctx, params, false);
      const months = trace.length;
      const withStart = B.computeMetrics(data, trace, 100, "2020-12-01", { ledgerResult: result, startingCapital: 1000 });
      const withoutStart = B.computeMetrics(data, trace, 100, "2020-12-01", { ledgerResult: result, startingCapital: 0 });
      assert(
        approxEqual(withStart.totalCommitted, 1000 + 100 * months, 1e-6),
        `totalCommitted mismatch: expected ${1000 + 100 * months}, got ${withStart.totalCommitted}`
      );
      assert(
        withStart.xirr !== withoutStart.xirr,
        "XIRR should change when the startingCapital t0 outflow is included vs. omitted on the same trace"
      );
    });

    // 21. findATH locates the actual maximum close and its date, not just
    // the final value — built on a synthetic series with a known interior
    // peak so the expected answer isn't the trivially-last point.
    check("21. DataCheck.findATH finds the true maximum, not the last value", (assert) => {
      const closes = [100, 200, 500, 300, 400]; // peak at index 2
      const data = { startDate: "2020-01-01", closes };
      const ath = global.DataCheck.findATH(data);
      assert(approxEqual(ath.price, 500, 1e-9), `expected ATH price 500, got ${ath.price}`);
      assert(ath.date === "2020-01-03", `expected ATH date 2020-01-03 (index 2), got ${ath.date}`);
    });

    // 22. dataHealth: zero/negative closes are counted, and gapDays comes
    // straight from the committed fillCount field (0 when absent, for
    // series generated before that field existed).
    check("22. DataCheck.dataHealth counts zero/negative closes and reads fillCount", (assert) => {
      const withBadCloses = { startDate: "2020-01-01", closes: [100, 0, -5, 200], fillCount: 3 };
      const health = global.DataCheck.dataHealth(withBadCloses);
      assert(health.zeroOrNegativeCount === 2, `expected 2 zero/negative closes, got ${health.zeroOrNegativeCount}`);
      assert(health.gapDays === 3, `expected gapDays to read fillCount (3), got ${health.gapDays}`);
      assert(health.rows === 4, `expected rows 4, got ${health.rows}`);

      const noFillCount = { startDate: "2020-01-01", closes: [100, 200] };
      assert(global.DataCheck.dataHealth(noFillCount).gapDays === 0, "expected gapDays to default to 0 when fillCount is absent");
    });

    // 23. staleDays: a committed series more than a few days behind the
    // wall clock is exactly what "DATA FAILED — N days stale" is meant to
    // catch — check both a stale and a fresh reference date against the
    // same last date.
    check("23. DataCheck.staleDays measures days between last date and now", (assert) => {
      const lastDate = "2026-05-23";
      const staleNow = new Date("2026-09-01T00:00:00Z");
      const freshNow = new Date("2026-05-24T12:00:00Z");
      assert(
        global.DataCheck.staleDays(lastDate, staleNow) === 101,
        `expected 101 stale days, got ${global.DataCheck.staleDays(lastDate, staleNow)}`
      );
      assert(
        global.DataCheck.staleDays(lastDate, freshNow) === 1,
        `expected 1 stale day, got ${global.DataCheck.staleDays(lastDate, freshNow)}`
      );
    });

    // 24. blockShuffle: output is a permutation of the input (same multiset,
    // same length), reproducible under a fixed seed, and degenerates to the
    // identity when the block spans the whole series (only one order is
    // possible with a single block).
    check("24. blockShuffle preserves the multiset and is deterministic under a seeded RNG", (assert) => {
      const src = Float64Array.from({ length: 30 }, (_, i) => i);
      const shuffledA = BM.blockShuffle(src, 12, BM.mulberry32(3));
      const shuffledB = BM.blockShuffle(src, 12, BM.mulberry32(3));
      assert(shuffledA.length === src.length, `expected length ${src.length}, got ${shuffledA.length}`);
      assert(
        Array.from(shuffledA)
          .sort((a, b) => a - b)
          .every((v, i) => v === i),
        "expected blockShuffle to be a permutation containing every original element exactly once"
      );
      assert(
        Array.from(shuffledA).every((v, i) => v === shuffledB[i]),
        "expected the same seed to reproduce the same shuffle"
      );
      const single = BM.blockShuffle(src, 40, BM.mulberry32(1));
      assert(
        Array.from(single).every((v, i) => v === i),
        "a single block spanning the whole series has only one possible order (identity)"
      );
    });

    // 25. blockShuffle reorders BLOCKS, never elements within a block — each
    // contiguous 12-run in the output must still count up by exactly 1,
    // whichever original block it turns out to be.
    check("25. blockShuffle keeps each block's internal order intact, only reorders blocks", (assert) => {
      const src = Float64Array.from({ length: 24 }, (_, i) => i);
      const shuffled = BM.blockShuffle(src, 12, BM.mulberry32(5));
      for (let b = 0; b < 2; b++) {
        const block = Array.from(shuffled.slice(b * 12, b * 12 + 12));
        for (let i = 1; i < block.length; i++) {
          assert(block[i] === block[i - 1] + 1, `block ${b} lost internal order: ${block}`);
        }
      }
    });

    // 26. signalPermutationTest degenerate case, mirroring test 11: at
    // exponent 0 the power-law multiplier is 1 regardless of the fair/price
    // ratio (calibrationConstant short-circuits to 1, and anything^0 is 1),
    // so shuffling the ratio changes nothing about the run — every
    // replicate ties the observed result on BOTH metrics, giving the same
    // "no significance" p=1 the legacy test reports for a constant array.
    check("26. signalPermutationTest reports no significance for a constant (untimed) strategy", (assert) => {
      const dates = BM.monthStarts("2018-01-01", "2020-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const fair = Float64Array.from(prices, (p, i) => p * (1 + 0.2 * Math.sin(i)));
      const s = { strategyType: "power", exponent: 0, mMin: 0, mMax: 5, calibrate: true, targetDeployment: 1 };
      const perm = BM.signalPermutationTest(fair, prices, 500, s, { fundingMode: "strict" }, { iterations: 300, seed: 7 });
      assert(perm.pValue === 1, `expected p=1 for exponent-0 (untimed) strategy, got ${perm.pValue}`);
      assert(perm.nullSd < 1e-9, `expected a near-zero-spread null BTC distribution, got sd=${perm.nullSd}`);
      assert(perm.pValueTotalValue === 1, `expected p=1 for total value too, got ${perm.pValueTotalValue}`);
      assert(perm.nullSdTotalValue < 1e-9, `expected a near-zero-spread null total-value distribution, got sd=${perm.nullSdTotalValue}`);
    });

    // 27. signalPermutationTest's own observed run (no shuffling) must match
    // an independently computed buildStrategyMultipliers + ledger run on the
    // same fair/prices — this is the "full re-run from scratch" contract:
    // ratio = fair/price then fair' = ratio*price must round-trip exactly.
    check("27. signalPermutationTest's observed run matches a direct buildStrategyMultipliers + ledger run", (assert) => {
      const dates = BM.monthStarts("2018-01-01", "2021-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const fair = Float64Array.from(BM.fairValueSeries(dates, "full"));
      const s = { strategyType: "threshold", mMin: 0, mMax: 4, threshold: { enterThreshold: 1.2, baseRate: 0.5, reserveSpendFraction: 0.3 } };
      const fundingOpts = { fundingMode: "strict" };
      const mult = BM.buildStrategyMultipliers(fair, prices, 500, s, fundingOpts);
      const direct = BM.runWithLumpSum(prices, mult, 500, fundingOpts, false);
      const perm = BM.signalPermutationTest(fair, prices, 500, s, fundingOpts, { iterations: 50, seed: 3 });
      assert(approxEqual(perm.observedBtc, direct.btc, 1e-9), `observed btc mismatch: perm=${perm.observedBtc} direct=${direct.btc}`);
      assert(
        approxEqual(perm.observedTotalValue, direct.totalValue, 1e-9),
        `observed totalValue mismatch: perm=${perm.observedTotalValue} direct=${direct.totalValue}`
      );
    });

    // 28. The whole point of the signal-permutation test: for a
    // path-dependent (threshold) strategy, re-deriving the multiplier from
    // a shuffled SIGNAL must actually change the multiplier VALUES, not
    // just their order, because each month's multiplier depends on the
    // running reserve balance carried in from every earlier month. The
    // legacy test (shuffling the multiplier array directly) could only ever
    // reorder the exact same values — this checks the new test does not
    // silently degenerate into that.
    check("28. signalPermutationTest re-derives the threshold multiplier from scratch, not just reorders it", (assert) => {
      const dates = BM.monthStarts("2018-01-01", "2021-12-01");
      const prices = Float64Array.from(dates, BM.closeOn);
      const fair = Float64Array.from(BM.fairValueSeries(dates, "full"));
      const s = { strategyType: "threshold", mMin: 0, mMax: 4, threshold: { enterThreshold: 1.2, baseRate: 0.5, reserveSpendFraction: 0.3 } };
      const fundingOpts = { fundingMode: "strict" };
      const realMult = BM.buildStrategyMultipliers(fair, prices, 500, s, fundingOpts);
      const ratio = Float64Array.from(prices, (p, i) => fair[i] / p);
      const shuffledRatio = BM.blockShuffle(ratio, 12, BM.mulberry32(11));
      const shuffledFair = Float64Array.from(shuffledRatio, (r, i) => r * prices[i]);
      const shuffledMult = BM.buildStrategyMultipliers(shuffledFair, prices, 500, s, fundingOpts);
      const realSorted = Array.from(realMult).sort((a, b) => a - b);
      const shuffledSorted = Array.from(shuffledMult).sort((a, b) => a - b);
      let identicalMultiset = realSorted.length === shuffledSorted.length;
      for (let i = 0; identicalMultiset && i < realSorted.length; i++) {
        if (!approxEqual(realSorted[i], shuffledSorted[i], 1e-9)) identicalMultiset = false;
      }
      assert(
        !identicalMultiset,
        "expected the re-derived multiplier VALUES (not just their order) to differ under a shuffled signal — a threshold " +
          "strategy's multiplier depends on the running reserve balance, so this must not degenerate into a reordering"
      );
    });

    // 29. rollingWindowStudy and the main backtest must agree exactly on BTC
    // accumulated when asked the same question: one strategy, over one
    // window, with no calibration (k≡1) or trailing residual band to make
    // the two systems' genuinely different calibration schemes diverge (see
    // Backtest.runStrategy's comment — the main backtest's annual trailing
    // no-lookahead k and the self-contained per-window k are deliberately
    // different algorithms, not comparable when calibration is actually
    // engaged). fitMode 'full' also makes the fair-value fit itself
    // independent of which window/context computed it. Under those
    // controls, both paths must reduce to literally the same multiplier
    // array and the same simulateLedger call — this is the regression test
    // for rolling.js silently skipping (NaN-ing) the threshold strategy
    // instead of running it through Backtest.runStrategy like every other
    // strategy type.
    check("29. rollingWindowStudy matches the main backtest's BTC, for all three strategy types", (assert) => {
      const dataStart = "2018-01-01";
      const dataEnd = "2021-12-01";
      const deposit = 500;

      const cases = [
        {
          label: "linear power-law",
          rollingStrategy: { name: "Linear", exponent: 1, mMin: 0, mMax: 5 },
          backtestParams: { p: 1, mMin: 0, mMax: 5 },
        },
        {
          label: "squared power-law",
          rollingStrategy: { name: "Squared", exponent: 2, mMin: 0, mMax: 5 },
          backtestParams: { p: 2, mMin: 0, mMax: 5 },
        },
        {
          label: "threshold",
          rollingStrategy: {
            name: "Threshold",
            strategyType: "threshold",
            mMin: 0,
            mMax: 4,
            threshold: { enterThreshold: 1.3, baseRate: 0.6, reserveSpendFraction: 0.25, useBand: false },
          },
          backtestParams: {
            p: 0,
            mMin: 0,
            mMax: 4,
            strategyType: "threshold",
            threshold: { enterThreshold: 1.3, baseRate: 0.6, reserveSpendFraction: 0.25, useBand: false },
          },
        },
      ];

      for (const c of cases) {
        const total = BM.monthStarts(dataStart, dataEnd).length;
        const study = R.rollingWindowStudy({
          windowMonths: total,
          stepMonths: 1,
          deposit,
          fitMode: "full",
          calibrate: false,
          strategies: [c.rollingStrategy],
          dataStart,
          dataEnd,
        });
        assert(study.windows.length === 1, `${c.label}: expected exactly one window spanning the full range, got ${study.windows.length}`);
        const w = study.windows[0];
        const rollingBtc = w.dcaBtc * (1 + w.strategies[0].deltaBtcPct / 100);

        const data = global.BTC_DATA;
        const context = B.prepareFairValueContext(data, dataStart, dataEnd, "full");
        const params = {
          ...c.backtestParams,
          deposit,
          fundingMode: "strict",
          startingCapital: 0,
          reserveRateAnnual: 0,
          lumpSumAtStart: false,
        };
        const { result } = B.runLedger(data, context, params, false);

        assert(
          approxEqual(rollingBtc, result.btc, 1e-6),
          `${c.label}: rollingWindowStudy btc=${rollingBtc} != main backtest btc=${result.btc}`
        );
      }
    });

    return results;
  }

  global.TestsCore = { runAllTests };
})(typeof window !== "undefined" ? window : globalThis);
