// WTYT — usage-metrics client (0.5.0). A thin sender: every counter lives in the
// background service worker (one context → serialized read-modify-write, no cross-tab
// races), so this module only forwards events to it via chrome.runtime.sendMessage.
//
// Loaded in every world that fires events: the content scripts (YouTube) via the
// manifest content_scripts array, and the extension pages (options/welcome/notes) via
// their own <script> tags. background.js owns the store, the 30-min session rotation,
// the opt-in gate, and aggregation — see recordMetric()/getMetricsSummary() there.
//
// Records ONLY event types, surfaces, counts, tokens, and timestamps — never a title,
// URL, or any video content. Opt-in is honored in the background (a disabled bump is a
// no-op there), so callers never need to check it.

const WTYT_METRICS = (() => {
  // Fire-and-forget. No callback ⟹ no "message port closed" lastError noise. The try/catch
  // guards the "Extension context invalidated" throw a stale content script hits after the
  // extension is reloaded — telemetry must never break the page.
  function bump(event, opts) {
    try {
      chrome.runtime.sendMessage({ type: 'metric', event, opts: opts || {} });
    } catch (e) {
      /* stale content-script context after a reload — ignore */
    }
  }

  function getSummary() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'getMetrics' }, (res) =>
          resolve(chrome.runtime.lastError ? null : res)
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  function reset() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'resetMetrics' }, (res) =>
          resolve(chrome.runtime.lastError ? null : res)
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  return { bump, getSummary, reset };
})();
