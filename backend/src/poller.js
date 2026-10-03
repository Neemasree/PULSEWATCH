/**
 * poller.js
 * Adaptive polling engine — one independent loop per monitor (keyed by monitorId).
 *
 * Adaptive interval rules (Phase 1.5):
 *   base        = monitor.interval_seconds * 1000  (minimum 5 s, from DB)
 *   INTERVAL_MAX = max(60 000, base)               (never less than 60 s ceiling)
 *   start       = base
 *   healthy     → next = min(current × 1.5, INTERVAL_MAX)
 *   anomalous or down → next = base  (reset to monitor's own base, not a global 5 s)
 *
 * "Up" definition:
 *   result.httpStatus === monitor.expected_status
 *   (not just < 400 — a 404 is "down" if expected_status is 200)
 *
 * On edit (notifyMonitorUpdated):
 *   - If interval_seconds changed → reset adaptive state (new base, new current)
 *   - If only other fields changed → preserve current adaptive state
 *   - downSince is always preserved across pause/resume
 */

const { pingUrl }        = require("./pinger");
const { storeMetric, storeIncident } = require("./redisClient");
const { detectAnomaly }  = require("./anomalyDetector");
const { sendSlackAlert } = require("./alerts");
const { getActiveMonitors, getPublicMonitors, registry } = require("./endpointRegistry");

const INTERVAL_GROWTH = 1.5;
const READINGS_WINDOW = 50;
const DOWN_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

// monitorId → { baseIntervalMs, currentIntervalMs, readings, checkCount,
//               timeoutHandle, lastStatus, downSince, expectedStatus }
const monitorState = new Map();

const lastDownAlertTime = new Map(); // monitorId → ms

let pollingStartTime    = null;
let totalAdaptiveChecks = 0;
let _onResultCb         = null;

function onResult(cb) { _onResultCb = cb; }

function baseInterval(monitor) {
  return Math.max(5_000, (monitor.interval_seconds || 10) * 1000);
}

function maxInterval(base) {
  return Math.max(60_000, base);
}

function makeState(monitor, preserveDownSince = null) {
  const base = baseInterval(monitor);
  return {
    baseIntervalMs:    base,
    currentIntervalMs: base,
    expectedStatus:    monitor.expected_status ?? 200,
    readings:          [],
    checkCount:        0,
    timeoutHandle:     null,
    lastStatus:        null,
    downSince:         preserveDownSince,
  };
}

// ─── Core check loop ──────────────────────────────────────────────────────────

async function checkMonitor(monitorId) {
  if (!monitorState.has(monitorId)) return;

  const state   = monitorState.get(monitorId);
  const monitor = getActiveMonitors().find((m) => m.id === monitorId);

  // Monitor was removed from registry while we were awaiting
  if (!monitor) {
    monitorState.delete(monitorId);
    return;
  }

  const raw = await pingUrl(monitor.url);

  // Override status based on expected_status
  const isExpected = raw.httpStatus === state.expectedStatus;
  const result = {
    ...raw,
    monitorId,
    url: monitor.url,
    status: (raw.httpStatus !== null && isExpected) ? "up" : "down",
  };

  state.checkCount++;
  totalAdaptiveChecks++;

  state.readings.push(result.responseTime);
  if (state.readings.length > READINGS_WINDOW) state.readings.shift();

  const anomaly  = detectAnomaly(state.readings.slice(0, -1), result.responseTime);
  result.anomaly = anomaly;

  await storeMetric(monitorId, result).catch((err) =>
    console.error(`[Storage] ${err.message}`)
  );

  if (anomaly.isAnomaly) sendSlackAlert(monitor.url, result, anomaly.zScore);

  // ── Down alert + incident tracking ────────────────────────────────────────
  const wasDown = state.lastStatus === "down";
  const isDown  = result.status === "down";
  const isUp    = result.status === "up";

  if (isDown) {
    if (!wasDown) {
      state.downSince = new Date(result.timestamp).getTime();
      console.log(`[Incident] Outage started: monitor ${monitorId} (${monitor.url})`);
    }
    const last = lastDownAlertTime.get(monitorId) || 0;
    if (Date.now() - last > DOWN_ALERT_COOLDOWN_MS) {
      lastDownAlertTime.set(monitorId, Date.now());
      sendSlackAlert(monitor.url, result, null);
    }
  }

  if (isUp && wasDown && state.downSince !== null) {
    const resolvedAt = new Date(result.timestamp).getTime();
    const incident   = {
      monitorId,
      url:        monitor.url,
      startedAt:  state.downSince,
      resolvedAt,
      durationMs: resolvedAt - state.downSince,
    };
    storeIncident(incident).catch((err) =>
      console.error(`[Incident] Failed to store: ${err.message}`)
    );
    console.log(`[Incident] Resolved: monitor ${monitorId} — ${(incident.durationMs / 1000).toFixed(0)}s`);
    state.downSince = null;
  }

  state.lastStatus = result.status;

  if (_onResultCb) _onResultCb(result, anomaly);

  const isProblematic = anomaly.isAnomaly || result.status === "down";
  const nextInterval  = isProblematic
    ? state.baseIntervalMs
    : Math.min(state.currentIntervalMs * INTERVAL_GROWTH, maxInterval(state.baseIntervalMs));

  if (nextInterval !== state.currentIntervalMs) {
    console.log(`[Poller] monitor ${monitorId}: ${(state.currentIntervalMs / 1000).toFixed(0)}s → ${(nextInterval / 1000).toFixed(0)}s`);
  }
  state.currentIntervalMs = nextInterval;

  console.log(
    `[Poll] monitor ${monitorId} (${monitor.url}) | ${result.status.toUpperCase()} | ` +
    `${result.responseTime}ms | z=${anomaly.zScore ?? "N/A"} | next=${(nextInterval / 1000).toFixed(1)}s`
  );

  if (monitorState.has(monitorId)) {
    state.timeoutHandle = setTimeout(() => checkMonitor(monitorId), nextInterval);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function startPolling() {
  pollingStartTime = Date.now();
  const monitors = getActiveMonitors();
  console.log(`[Poller] Starting adaptive polling for ${monitors.length} monitors`);

  monitors.forEach((m, i) => {
    monitorState.set(m.id, makeState(m));
    setTimeout(() => checkMonitor(m.id), i * 400);
  });

  // "added" carries (monitor, prevMonitor?)
  registry.on("added", (monitor, prevMonitor) => {
    if (monitorState.has(monitor.id)) {
      // Already running — this is an edit. Decide whether to reset adaptive state.
      const existing = monitorState.get(monitor.id);
      const intervalChanged = prevMonitor &&
        prevMonitor.interval_seconds !== monitor.interval_seconds;

      if (intervalChanged) {
        // New base interval — reset adaptive state, preserve downSince
        const newState = makeState(monitor, existing.downSince);
        clearTimeout(existing.timeoutHandle);
        monitorState.set(monitor.id, newState);
        setTimeout(() => checkMonitor(monitor.id), 0);
      } else {
        // Only metadata changed — update expectedStatus in-place, keep adaptive state
        existing.expectedStatus = monitor.expected_status ?? 200;
      }
      return;
    }

    console.log(`[Poller] Started monitoring: monitor ${monitor.id} (${monitor.url})`);
    monitorState.set(monitor.id, makeState(monitor));
    setTimeout(() => checkMonitor(monitor.id), 0);
  });

  registry.on("removed", (monitor) => {
    const state = monitorState.get(monitor.id);
    if (state?.timeoutHandle) clearTimeout(state.timeoutHandle);
    // Preserve downSince in case monitor is re-added (resume after pause)
    // by keeping the entry briefly — but we must delete it to stop polling.
    monitorState.delete(monitor.id);
    console.log(`[Poller] Stopped monitoring: monitor ${monitor.id} (${monitor.url})`);
  });

  setInterval(logComparisonStats, 5 * 60 * 1000);
}

function stopPolling() {
  for (const [, s] of monitorState) {
    if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
  }
  monitorState.clear();
}

function logComparisonStats() {
  if (!pollingStartTime) return;
  const elapsedSec = (Date.now() - pollingStartTime) / 1000;
  const fixedTotal = Math.floor((elapsedSec / 10) * monitorState.size);
  const saved      = fixedTotal - totalAdaptiveChecks;
  const pct        = fixedTotal > 0 ? ((saved / fixedTotal) * 100).toFixed(1) : "0.0";
  console.log("─".repeat(60));
  console.log(`[Adaptive Polling] ${(elapsedSec / 60).toFixed(1)}min | adaptive=${totalAdaptiveChecks} | fixed=${fixedTotal} | saved=${pct}%`);
  for (const [id, s] of monitorState) {
    console.log(`  monitor ${id}: ${s.checkCount} checks, interval=${(s.currentIntervalMs / 1000).toFixed(0)}s`);
  }
  console.log("─".repeat(60));
}

function getPollingState() {
  const elapsedMs  = pollingStartTime ? Date.now() - pollingStartTime : 0;
  const fixedTotal = Math.floor((elapsedMs / 10_000) * monitorState.size);
  const saved      = fixedTotal - totalAdaptiveChecks;
  return {
    monitorCount:       monitorState.size,
    totalAdaptiveChecks,
    fixedTotalChecks:   fixedTotal,
    savedPct: fixedTotal > 0 ? parseFloat(((saved / fixedTotal) * 100).toFixed(1)) : 0,
    monitorIntervals: Object.fromEntries(
      [...monitorState.entries()].map(([id, s]) => [id, s.currentIntervalMs])
    ),
  };
}

/**
 * Returns ongoing outages for public monitors only.
 * @returns {Array<{monitorId, url, startedAt, ongoing: true}>}
 */
function getOngoingOutages() {
  const publicIds = new Set(getPublicMonitors().map((m) => m.id));
  const ongoing   = [];
  for (const [monitorId, state] of monitorState.entries()) {
    if (state.lastStatus === "down" && state.downSince !== null && publicIds.has(monitorId)) {
      const monitor = getActiveMonitors().find((m) => m.id === monitorId);
      ongoing.push({ monitorId, url: monitor?.url ?? "", startedAt: state.downSince, ongoing: true });
    }
  }
  return ongoing;
}

/**
 * Returns monitor objects visible to this user for ownership-scoped endpoints.
 * Includes paused monitors (they have history and should show as paused).
 */
function getMonitorsForUser(userId, isAdmin) {
  const { getMonitorsForUser: reg } = require("./endpointRegistry");
  return reg(userId, isAdmin);
}

module.exports = {
  startPolling,
  stopPolling,
  onResult,
  getPollingState,
  getOngoingOutages,
  getMonitorsForUser,
  // Expose for tests
  _monitorState: monitorState,
};
