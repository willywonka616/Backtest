# BTC Power-Law DCA Backtester

A single-page, no-build web app that backtests and compares three monthly BTC accumulation
strategies against a realistic cash ledger:

1. **DCA** — buy a fixed dollar amount every month, no matter what.
2. **Power-law linear** — scale the monthly buy by how far price sits below (or above) its
   power-law fair value, linearly.
3. **Power-law squared** — the same idea, but the scaling reacts more aggressively (squared).

It opens directly from `file://` (double-click `index.html`) and is deployable to GitHub Pages
as-is — no bundler, no server, no dependencies beyond the vendored chart library.

## Running it

Just open `index.html` in a browser. `tests.html` runs the correctness checks (see below).

## Refreshing the price data

`js/data.js` is a committed snapshot of daily BTC/USD closes, not fetched at runtime. To
regenerate it:

```
node tools/fetch-data.mjs
```

This tries CoinGecko's `market_chart` endpoint first, falls back to Coin Metrics' community
CSV if that fails, and finally falls back to the snapshot committed at
`tools/btc-fallback.csv` if neither is reachable. Any missing calendar day in the chosen
source is forward-filled, and the script prints how many days were filled plus the last date
and close so a refresh is verifiable at a glance.

## What the calibration constant (k) is for

BTC spends most of its time trading *below* its power-law fair value, so the raw ratio
`fairValue / price` has a long-run average noticeably above 1. Left uncorrected, strategies 2
and 3 would simply deploy more total capital than plain DCA and "win" for that reason alone —
not because of *when* they bought, but because they spent more overall (until the cash
reserve runs dry).

The calibration constant `k` removes that bias: it's set so the median of `k · ratio^p`, taken
over a trailing (up to 4-year) window of data available *before* the recompute date, is 1. With
calibration on, all three strategies deploy the same amount over the long run — they differ
purely in *timing*, which is the comparison actually worth making. `k` is recomputed once a
year (not every month) to keep it stable, and the app reports the range of `k` actually applied
to each strategy's purchases in the results table.

Calibration can be switched off in the controls to see the raw, uncorrected effect instead.

## Fit modes

- **Expanding** (default) — at each purchase date, the power-law curve is refit using only
  price history available *before* that date. This is the honest mode: no strategy ever acts
  on information it couldn't have had at the time. It requires at least 1,500 days of price
  history before the first purchase date.
- **Full-sample** — one fit over the entire dataset, applied uniformly. Faster, but every
  purchase implicitly uses future price information — labelled *in-sample (optimistic)* in the
  UI. Useful for sanity-checking against the expanding mode, not for drawing conclusions.

## The optimizer

The collapsed "Optimizer" section grid-searches `mMin`/`mMax` boundaries for a chosen strategy
and objective, and shows:

- a heatmap of the objective relative to the DCA baseline (a broad plateau is a more credible
  signal than a single bright cell),
- a top-10 table, and
- a robustness panel that reruns the top result on three fixed sub-periods to check whether it
  still beats DCA outside the window it was fitted on.

**These boundaries are fitted to one realised BTC price history.** A parameter set that only
wins on the full period, or on one sub-period, is curve-fitting — not a strategy. Nothing here
is investment advice.

## Data verification

Section 01 checks the committed price series against a live source (CoinGecko) on load,
plus checks that need no network at all: freshness (the last date can't be more than 3 days
old), gaps and zero/negative closes (the pipeline's own forward-fill count, embedded in
`js/data.js` as `fillCount` — see `tools/fetch-data.mjs`), fixed price anchors (the all-time
high has to land where independent aggregators put it), and shape diagnostics over a trailing
2-year window (real BTC returns are fat-tailed — a kurtosis near 3 would mean the series was
generated from a normal distribution, not observed; the shape checks use a recent window
rather than the full 2010– history, since BTC's early years are legitimately far more volatile
than anything since). The live check needs network access and same-origin fetch; it can't run
under `file://` (CORS) and is reported as "unavailable," not as a failure, in that case.

A hard failure on freshness, gaps, zero/negative closes, the ATH anchor, or a live-source
mismatch disables the backtest controls until it's resolved — unlike volatility/big-move-day/
kurtosis/repeated-close diagnostics, which get their own pass/fail indicator but stay advisory
only, since they can legitimately vary run to run without indicating a broken pipeline.

### Mobile readouts

The verdict strip and numbers block above are designed to be read on a phone without opening
a file: single column, monospace right-aligned values, a coloured dot plus expected range
under anything that has one. Every major section (data verification, results, benchmarks,
rolling windows) is collapsible with its headline visible in the collapsed header, so the page
scans without expanding anything, and every table collapses to stacked label/value rows below
600px instead of scrolling horizontally.

A **Copy** button next to each section heading copies a terse, fixed-width plain-text summary
of that section — short enough to paste from a phone into a chat. A **Copy all** button at the
top of the page joins all four (data check, backtest, benchmarks, rolling) with a timestamp,
for the single artifact worth pasting when discussing a run. The data-check block is also
logged to the console automatically on load, and `window.summary()` returns the same
copy-all text — both useful if the page fails to render but the data question still needs
answering.

## Benchmarks: ceiling, floor, and significance

Section 08 answers the question the raw comparison table can't: is a strategy's edge over DCA
real, or is it noise? `perfectTiming()` computes the exact best- and worst-case allocation any
timing rule could achieve under the same deposit-can-only-be-spent-later constraint — if the
ceiling itself is only a few percent above DCA, no signal could have helped over that window,
and the model isn't what to blame.

The significance test is `signalPermutationTest()`. It shuffles the **fair/price ratio** — the
one primitive every strategy derives its multiplier from — in contiguous **12-month blocks**
using a seeded RNG, then reruns the *entire* strategy from scratch on each shuffled signal:
calibration, clamps, and the ledger. Shuffling whole 12-month blocks (not individual months)
keeps a shuffled replicate's regime persistence intact — a real multi-month over/undervaluation
stretch survives, only *when* it lands is randomized; shuffling single months would erase that
persistence and bias every replicate toward the mean. It reports a p-value and percentile for
**both** BTC accumulated and total value (BTC + cash left), each against its own histogram of
2000 shuffled replicates with the observed result marked.

This replaced an earlier, invalid version, `permutationTest()`, that shuffled the **multiplier
array** directly instead of the underlying ratio. That's harmless for the power-law strategies,
whose multiplier is a stateless function of price alone, but wrong for the threshold strategy:
its multiplier at month *t* depends on the reserve balance carried in from every earlier
month, so permuting the multiplier array produces sequences the strategy could never actually
have generated — the null distribution it built was not a real threshold strategy's null
distribution. The old test is kept, unchanged, behind a **"legacy — invalid for threshold"**
toggle next to the permutation chart (off by default) purely so the two can be compared.

## Rolling windows

Section 09 slides a fixed-length window (24–60 months, selectable) across the entire available
history and reruns the comparison in each one. A single full-period backtest is one
observation; this shows the distribution. Consecutive windows share almost all their months, so
the window *count* overstates how much independent evidence there is — the panel reports
`effectiveN` (roughly `totalMonths / windowMonths`) alongside it, and always spans the full
available history regardless of whatever period is selected for the main backtest above, since
the point is to see how the result varies across different historical regimes.

## Funding modes and fair comparison

By default every strategy funds itself from its own reserve, which starts at $0 and can never go
negative (**strict**). Two other modes exist:

- **Seeded** — same rule (spend = min(desired, balance), balance ≥ 0), but the reserve starts at
  the global starting capital instead of $0.
- **Unbound** — spends the full desired amount every month regardless of balance, letting the
  reserve go negative (i.e. borrows). This is a **diagnostic only, never a runnable strategy** —
  the UI shows an amber banner, mutes the results, and the optimizer refuses to run under it. Its
  purpose is separating two different explanations for a weak result: run the same strategy under
  strict and unbound funding and compare the permutation p-value (Section 08) — if it's still
  insignificant under unbound (no funding constraint at all), the multiplier's *shape* isn't
  producing a timing edge; if it only becomes significant under unbound, the funding constraint
  was suppressing a real signal.

**Starting capital** and the **yield on reserve** (an annual rate credited to whatever's sitting
unspent, compounded monthly, default 0%) are global controls — applied identically to every
strategy, DCA included, so the comparison never accidentally stacks "more capital" on top of
"better timing." Each strategy has its own **"deploy starting capital immediately"** toggle:
checked, its share of the starting capital buys BTC at t0 outside the reserve entirely; unchecked,
it's held as reserve like any other cash. DCA defaults to immediate deployment; the power-law
strategies default to holding it, since choosing *when* to deploy is the whole point of those
strategies.

A reduced deployment level is expressed as a **target deployment ratio** (0.3–1.0, default 1.0,
per strategy), never as a smaller deposit — the deposit stays identical across strategies so the
comparison stays about timing, not savings rate. It works by changing what the calibration
constant solves for: `k = targetDeployment / median(rawRatio)` instead of `k = 1 / median(rawRatio)`.
**Total committed capital** (`startingCapital + deposit × months`) is shown in the results table for
every strategy; if it differs between strategies being compared, the "vs. DCA" delta rows are
withheld rather than shown as a comparison, since a delta is only meaningful when every strategy
put in the same amount. XIRR and MoIC include starting capital as an outflow at t0.

**What to run first:** under strict funding, take the squared strategy and sweep target deployment
from 1.0 down to 0.5 (Section 08b). Watch the permutation **p-value**, not the return. If p stays
high throughout the sweep, the multiplier's shape isn't producing a timing edge at any deployment
level. If p drops sharply only as target deployment falls (i.e. only once the strategy is starved
of capital relative to its desired spend), the *funding constraint* — not the model — was doing
the work.

## The threshold reserve strategy

A fourth, optional strategy (off by default): instead of a continuous power-law multiplier, it
switches between two fixed behaviors based on whether price is currently in a "deep value" zone.
Below the enter threshold (fair/price ratio, default 1.3 — or, if the "±σ residual band" option is
checked, `exp(bandSigma · σ)` where σ is the trailing no-lookahead residual stdev for that year) it
buys a slow `baseRate × deposit` (default 0.6×, building reserve); at or above it, it buys
`deposit + reserveSpendFraction × balance` (default 0.25× whatever reserve has accumulated). Unlike
the power-law multiplier, this rule depends on the running reserve balance, so it can't be
precomputed as a stateless function of price alone — it runs its own forward pass mirroring the
shared ledger's exact balance mechanics, then flows through everything else (rolling windows,
benchmarks) exactly like any other strategy from that point on. It's also exactly why the
significance test has to shuffle the *signal* rather than the *multiplier* (see Benchmarks,
above): a threshold multiplier array bakes in this strategy's own reserve history, so shuffling
that array directly isn't a valid null distribution for it.

## Assumptions and limitations

- **USD only.** The power law is a USD-denominated relationship; converting results to another
  currency would mix in that currency's FX return against the dollar, which is not what this
  tool measures.
- **The power law is assumed to hold.** It has held reasonably well over BTC's trading history
  so far. That is an empirical observation, not a law of physics — it can break down, and nothing
  here should be read as a prediction that it won't.
- **Past price paths do not repeat.** A backtest, however carefully built, only ever replays one
  realised history. It cannot show what would have happened on a different one.
- **Optimized boundaries are fitted to that one history.** Treat the optimizer's output as a
  description of what worked on the data you gave it, not a forecast of what will work next.

If you're reading this in a year or two: the numbers on screen answer "how would this specific
rule have performed on the price history that actually happened," nothing more.

## Correctness checks

Open `tests.html`. It runs plain-assertion checks (no framework) covering: ledger
conservation, degenerate-boundary and zero-exponent equivalence to plain DCA, power-law fit
recovery on synthetic data, XIRR sanity, the no-lookahead guarantee of the expanding fit,
agreement between `Backtest.runLedger` and the shared `Benchmarks.simulateLedger` (there is
exactly one implementation of the ledger arithmetic — two would drift apart and quietly
invalidate every comparison the app makes), the ceiling/floor bracketing DCA, the legacy
multiplier-permutation test's degenerate case, the data-verification helpers, the
`targetDeployment` calibration identity, `lumpSumAtStart` conservation (same total committed,
different deployment timing), the threshold strategy's baseRate/reserve-fraction shape on a
hand-worked synthetic series, unbound funding's ability to go into debt versus strict/seeded
never doing so, `computeMetrics` folding starting capital into `totalCommitted` and the XIRR t0
outflow, the mobile data-check helpers (`findATH` locating a synthetic series' true peak rather
than its last value, `dataHealth` counting zero/negative closes and reading the committed
`fillCount`, and `staleDays` against both a stale and a fresh reference date), and the signal
permutation test (`blockShuffle`'s block-order-only shuffling, its degenerate case at exponent 0,
its observed run matching a direct ledger run exactly, and — the point of the whole rewrite —
that a threshold strategy's re-derived multiplier actually changes value, not just position,
under a shuffled signal).

## Repository layout

```
index.html            markup + inline CSS
js/data.js             BTC daily close series (committed, regenerate with tools/fetch-data.mjs)
js/powerlaw.js          power-law OLS fitting (full + expanding modes)
js/backtest.js          ledger simulation (via js/benchmarks.js), calibration, metrics, XIRR
js/benchmarks.js        shared simulateLedger(), perfect-timing ceiling/floor, signal permutation
                        test (+ legacy multiplier-permutation, kept behind a toggle)
js/rolling.js           rolling-window robustness study
js/datacheck.js         live-source + anchor + shape verification of js/data.js
js/optimizer.js         mMin/mMax grid search + robustness sub-periods
js/optimizer-worker.js  Web Worker entry point for the optimizer sweep
js/charts.js            chart construction (uPlot + canvas) + brush/heatmap/histogram handling
js/app.js               state, controls, wiring, rendering
js/tests-core.js        correctness-check assertions, used by tests.html
js/vendor/              vendored uPlot
tools/fetch-data.mjs    regenerates js/data.js
tools/btc-fallback.csv  offline fallback data snapshot
tests.html              runs js/tests-core.js in a page
```
