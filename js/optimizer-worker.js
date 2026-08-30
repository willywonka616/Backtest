// Web Worker entry point for the optimizer grid search.
// Loaded with `new Worker('js/optimizer-worker.js')` when the environment
// allows it (see app.js for the main-thread chunked fallback used under
// file:// where worker script loading is commonly blocked).
importScripts("data.js", "powerlaw.js", "backtest.js", "optimizer.js");

self.onmessage = function (e) {
  const opts = e.data;
  try {
    const result = Optimizer.runSweep(self.BTC_DATA, opts, (done, total) => {
      self.postMessage({ type: "progress", done, total });
    });
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};
