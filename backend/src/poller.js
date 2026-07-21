/**
 * poller.js
 * Adaptive polling engine — each URL runs its own recursive setTimeout loop.
 *
 * Algorithm (TCP congestion control analogy):
 *   Healthy → interval × 1.5  (gradual back-off, capped at 60 s)
 *   Anomaly / down → reset to 5 s  (sharp response, maximum visibility)
 *
 * Dynamically responds to endpoint registry events:
 *   "added"   → immediately starts polling the new URL
 *   "removed" → cancels the timeout for that URL
 */

const { pingUrl }        = require("./pinger");
const { storeMetric, storeIncident } = require("./redisClient");
const { detectAnomaly }  = require("./anomalyDetector");
const { sendSlackAlert } = require("./alerts");
const { getUrls, registry } = require("./endpointRegistry");

const INTERVAL_MIN_MS = 5_000;
const INTERVAL_MAX_MS = 60_000;
const INTERVAL_START  = 10_000;
const INTERVAL_GROWTH = 1.5;
const READINGS_WINDOW = 50;

// ── Down-alert cooldown ───────────────────────────────────────────────────────
// Tracks the last time a DOWN alert was sent per URL, separate from the
// anomaly alert cooldown in alerts.js. Prevents spamming when a site stays down.
const DOWN_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const lastDownAlertTime = new Map(); // url → timestamp ms

function shouldSendDownAlert(url) {
  const last = lastDownAlertTime.get(url) || 0;
  return Date.now() - last > DOWN_ALERT_COOLDOWN_MS;
}

function recordDownAlert(url) {
  lastDownAlertTime.set(url, Date.now());
}

// Per-URL runtime state
const urlState = new Map();

let pollingStartTime    = null;
let totalAdaptiveChecks = 0;
let _onResultCb         = null;

function onResult(cb) { _onResultCb = cb; }

// ─── Per-URL state factory ────────────────────────────────────────────────────
function makeState() {
  return {
    currentIntervalMs: INTERVAL_START,
    readings:          [],
    checkCount:        0,
    timeoutHandle:     null,
    lastStatus:        null,  // "up" | "down" | null — tracks previous check
    downSince:         null,  // ms timestamp when the current outage started, null if up
  };
}

// ─── Core check loop ──────────────────────────────────────────────────────────
async function checkUrl(url) {
  // If URL was removed while we were awaiting, just stop
  if (!urlState.has(url)) return;

  const state  = urlState.get(url);
  const result = await pingUrl(url);
  state.checkCount++;
  totalAdaptiveChecks++;

  state.readings.push(result.responseTime);
  if (state.readings.length > READINGS_WINDOW) state.readings.shift();

  const anomaly  = detectAnomaly(state.readings.slice(0, -1), result.responseTime);
  result.anomaly = anomaly;

  await storeMetric(url, result).catch((err) =>
    console.error(`[Storage] ${err.message}`)
  );

  // ── Anomaly alert (z-score spike) ─────────────────────────────────────────
  if (anomaly.isAnomaly) sendSlackAlert(url, result, anomaly.zScore);

  // ── Down alert + incident tracking ────────────────────────────────────────
  const wasUp   = state.lastStatus === "up";
  const wasDown = state.lastStatus === "down";
  const isDown  = result.status === "down";
  const isUp    = result.status === "up";

  if (isDown) {
    // Record when this outage started (only on the first DOWN after an UP)
    if (!wasDown) {
      state.downSince = new Date(result.timestamp).getTime();
      console.log(`[Incident] Outage started: ${url} at ${result.timestamp}`);
    }
    // Fire a DOWN Slack alert respecting the 5-min cooldown
    if (shouldSendDownAlert(url)) {
      recordDownAlert(url);
      sendSlackAlert(url, result, null);
      console.log(`[Alert] DOWN alert sent for ${url}`);
    }
  }

  if (isUp && wasDown && state.downSince !== null) {
    // DOWN → UP transition: persist a resolved incident record
    const resolvedAt  = new Date(result.timestamp).getTime();
    const durationMs  = resolvedAt - state.downSince;
    const incident    = { url, startedAt: state.downSince, resolvedAt, durationMs };
    storeIncident(incident).catch((err) =>
      console.error(`[Incident] Failed to store: ${err.message}`)
    );
    console.log(`[Incident] Resolved: ${url} — duration ${(durationMs / 1000).toFixed(0)}s`);
    state.downSince = null;
  }

  // Track status for next iteration
  state.lastStatus = result.status;

  if (_onResultCb) _onResultCb(result, anomaly);

  const isProblematic = anomaly.isAnomaly || result.status === "down";
  const nextInterval  = isProblematic
    ? INTERVAL_MIN_MS
    : Math.min(state.currentIntervalMs * INTERVAL_GROWTH, INTERVAL_MAX_MS);

  if (nextInterval !== state.currentIntervalMs) {
    console.log(`[Poller] ${url}: ${(state.currentIntervalMs/1000).toFixed(0)}s → ${(nextInterval/1000).toFixed(0)}s`);
  }

  state.currentIntervalMs = nextInterval;

  console.log(
    `[Poll] ${url} | ${result.status.toUpperCase()} | ${result.responseTime}ms` +
    ` | z=${anomaly.zScore ?? "N/A"} | next=${( nextInterval/1000).toFixed(1)}s`
  );

  // Guard again — URL might have been removed during the await above
  if (urlState.has(url)) {
    state.timeoutHandle = setTimeout(() => checkUrl(url), nextInterval);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startPolling() {
  pollingStartTime = Date.now();
  const urls = getUrls();
  console.log(`[Poller] Starting adaptive polling for ${urls.length} URLs`);

  urls.forEach((url, i) => {
    urlState.set(url, makeState());
    setTimeout(() => checkUrl(url), i * 400);
  });

  // React to runtime add/remove
  registry.on("added", (url) => {
    if (urlState.has(url)) return; // already running
    console.log(`[Poller] Started monitoring: ${url}`);
    urlState.set(url, makeState());
    setTimeout(() => checkUrl(url), 0);
  });

  registry.on("removed", (url) => {
    const state = urlState.get(url);
    if (state?.timeoutHandle) clearTimeout(state.timeoutHandle);
    urlState.delete(url);
    console.log(`[Poller] Stopped monitoring: ${url}`);
  });

  setInterval(logComparisonStats, 5 * 60 * 1000);
}

function stopPolling() {
  for (const [, s] of urlState) {
    if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
  }
  urlState.clear();
}

function logComparisonStats() {
  if (!pollingStartTime) return;
  const elapsedSec = (Date.now() - pollingStartTime) / 1000;
  const fixedTotal = Math.floor((elapsedSec / (INTERVAL_START / 1000)) * urlState.size);
  const saved      = fixedTotal - totalAdaptiveChecks;
  const pct        = fixedTotal > 0 ? ((saved / fixedTotal) * 100).toFixed(1) : "0.0";
  console.log("─".repeat(60));
  console.log(`[Adaptive Polling] ${(elapsedSec/60).toFixed(1)}min | adaptive=${totalAdaptiveChecks} | fixed=${fixedTotal} | saved=${pct}%`);
  for (const [url, s] of urlState) {
    console.log(`  ${url.replace(/^https?:\/\/(www\.)?/,"")}: ${s.checkCount} checks, interval=${(s.currentIntervalMs/1000).toFixed(0)}s`);
  }
  console.log("─".repeat(60));
}

function getPollingState() {
  const elapsedMs  = pollingStartTime ? Date.now() - pollingStartTime : 0;
  const fixedTotal = Math.floor((elapsedMs / INTERVAL_START) * urlState.size);
  const saved      = fixedTotal - totalAdaptiveChecks;
  return {
    monitoredUrls:      getUrls(),
    totalAdaptiveChecks,
    fixedTotalChecks:   fixedTotal,
    savedPct: fixedTotal > 0 ? parseFloat(((saved/fixedTotal)*100).toFixed(1)) : 0,
    urlIntervals: Object.fromEntries([...urlState.entries()].map(([u, s]) => [u, s.currentIntervalMs])),
  };
}

// Kept for backward compat — used by socketHandler
const MONITORED_URLS = { get current() { return getUrls(); } };

/**
 * Returns any currently ongoing outages (DOWN with no recovery yet).
 * Used by the incidents API to merge in-progress outages with resolved ones.
 * @returns {Array<{url, startedAt, ongoing: true}>}
 */
function getOngoingOutages() {
  const ongoing = [];
  for (const [url, state] of urlState.entries()) {
    if (state.lastStatus === "down" && state.downSince !== null) {
      ongoing.push({ url, startedAt: state.downSince, ongoing: true });
    }
  }
  return ongoing;
}

module.exports = { startPolling, stopPolling, onResult, getPollingState, getOngoingOutages, MONITORED_URLS: null, getUrls };
