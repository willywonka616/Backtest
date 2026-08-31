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
plus two checks that need no network at all: fixed price anchors (the all-time high has to
land where independent aggregators put it) and shape diagnostics (real BTC returns are
fat-tailed — a kurtosis near 3 would mean the series was generated from a normal distribution,
not observed). The live check needs network access and same-origin fetch; it can't run under
`file://` (CORS) and is reported as "unverified," not as a failure, in that case. Only a genuine
mismatch against the live source disables the backtest controls — a stale file or an
unreachable network never does.

## Benchmarks: ceiling, floor, and significance

Section 08 answers the question the raw comparison table can't: is a strategy's edge over DCA
real, or is it noise? `perfectTiming()` computes the exact best- and worst-case allocation any
timing rule could achieve under the same deposit-can-only-be-spent-later constraint — if the
ceiling itself is only a few percent above DCA, no signal could have helped over that window,
and the model isn't what to blame. `permutationTest()` reruns the ledger thousands of times
with the same multipliers shuffled onto different months; if the real chronological order
doesn't beat most of the shuffles, the observed edge came from the *size* of the multipliers,
not their *timing*.

## Rolling windows

Section 09 slides a fixed-length window (24–60 months, selectable) across the entire available
history and reruns the comparison in each one. A single full-period backtest is one
observation; this shows the distribution. Consecutive windows share almost all their months, so
the window *count* overstates how much independent evidence there is — the panel reports
`effectiveN` (roughly `totalMonths / windowMonths`) alongside it, and always spans the full
available history regardless of whatever period is selected for the main backtest above, since
the point is to see how the result varies across different historical regimes.

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
invalidate every comparison the app makes), the ceiling/floor bracketing DCA, the permutation
test's degenerate case, and the data-verification helpers.

## Repository layout

```
index.html            markup + inline CSS
js/data.js             BTC daily close series (committed, regenerate with tools/fetch-data.mjs)
js/powerlaw.js          power-law OLS fitting (full + expanding modes)
js/backtest.js          ledger simulation (via js/benchmarks.js), calibration, metrics, XIRR
js/benchmarks.js        shared simulateLedger(), perfect-timing ceiling/floor, permutation test
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
