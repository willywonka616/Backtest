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

Open `tests.html`. It runs plain-assertion checks (no framework) against `js/powerlaw.js` and
`js/backtest.js`: ledger conservation, degenerate-boundary and zero-exponent equivalence to
plain DCA, power-law fit recovery on synthetic data, XIRR sanity, and — the most important one —
that the expanding fit mode never uses a fit whose window extends past the purchase date it's
being applied to.

## Repository layout

```
index.html            markup + inline CSS
js/data.js             BTC daily close series (committed, regenerate with tools/fetch-data.mjs)
js/powerlaw.js          power-law OLS fitting (full + expanding modes)
js/backtest.js          ledger simulation, calibration, metrics, XIRR
js/optimizer.js         mMin/mMax grid search + robustness sub-periods
js/optimizer-worker.js  Web Worker entry point for the optimizer sweep
js/charts.js            chart construction (uPlot) + brush/heatmap handling
js/app.js               state, controls, wiring, rendering
js/tests-core.js        correctness-check assertions, used by tests.html
js/vendor/              vendored uPlot
tools/fetch-data.mjs    regenerates js/data.js
tools/btc-fallback.csv  offline fallback data snapshot
tests.html              runs js/tests-core.js in a page
```
