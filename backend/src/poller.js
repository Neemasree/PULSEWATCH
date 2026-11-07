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
const { storeMetric, acquireCooldown } = require("./redisClient");
const { openIncident, getOpenIncidentForMonitor, resolveIncident } = require("./db/incidents");
const { detectAnomaly }  = require("./anomalyDetector");
const { sendSlackAlert } = require("./alerts");
const { upsertCheckRollup, deleteOldRollups } = require("./db/rollups");
const { getActiveMaintenance } = require("./db/maintenance");
const { notify } = require("./notifier");
const { inspectCertificate } = require("./sslChecker");
const { getActiveMonitors, getPublicMonitors, registry } = require("./endpointRegistry");
// Imported lazily via getter to avoid circular dependency at module load time
function getBroadcastIncidentUpdate() {
  return require("./socketHandler").broadcastIncidentUpdate;
}

const INTERVAL_GROWTH = 1.5;
const READINGS_WINDOW = 50;
const DOWN_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

// monitorId → { baseIntervalMs, currentIntervalMs, readings, checkCount,
//               timeoutHandle, lastStatus, downSince, expectedStatus,
//               openIncidentId }
// openIncidentId: fast in-memory guard — the PG unique index is the final
// source of truth and handles the restart case via openIncident()'s 23505 recovery.
const monitorState = new Map();


let pollingStartTime    = null;
let totalAdaptiveChecks = 0;
let _onResultCb         = null;
let comparisonTimer     = null;
let sslTimer            = null;

function onResult(cb) { _onResultCb = cb; }

async function checkSsl(monitor) {
  if (monitor.check_ssl === false || !monitor.url.startsWith("https://")) return;
  const state = monitorState.get(monitor.id);
  if (!state) return;
  try {
    const certificate = await inspectCertificate(monitor.url);
    state.sslExpiresAt = certificate.sslExpiresAt;
    state.sslDaysLeft = certificate.sslDaysLeft;
    for (const threshold of [14, 7, 1]) {
      if (state.sslDaysLeft <= threshold && !state.sslAlerted[threshold]) {
        state.sslAlerted[threshold] = true;
        notify(monitor, "ssl_expiring", {
          sslDaysLeft: state.sslDaysLeft,
          sslExpiresAt: state.sslExpiresAt,
        });
      }
    }
  } catch (err) {
    console.error(`[SSL] monitor ${monitor.id}: ${err.message}`);
  }
}

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
    checkInFlight:     false,
    lastStatus:        null,
    downSince:         preserveDownSince,
    openIncidentId:    null,
    incidentHydrated: false,
    consecutiveFailures: 0,
    failureThreshold: monitor.failure_threshold ?? 2,
    sslExpiresAt: null,
    sslDaysLeft: null,
    sslAlerted: {},
  };
}

// ─── Core check loop ──────────────────────────────────────────────────────────

async function performMonitorCheck(monitorId) {
  if (!monitorState.has(monitorId)) return;

  const state   = monitorState.get(monitorId);
  const monitor = getActiveMonitors().find((m) => m.id === monitorId);

  // Monitor was removed from registry while we were awaiting
  if (!monitor) {
    monitorState.delete(monitorId);
    return;
  }

  // Rehydrate any active incident before the first check. Without this,
  // a restart followed by a healthy response could leave an OPEN incident
  // stranded forever because the in-memory incident ID was lost.
  if (!state.incidentHydrated) {
    const activeIncident = await getOpenIncidentForMonitor(monitorId);
    state.incidentHydrated = true;
    if (activeIncident) {
      state.openIncidentId = activeIncident.id;
      state.downSince = new Date(activeIncident.started_at).getTime();
      state.lastStatus = "down";
      state.consecutiveFailures = state.failureThreshold;
    }
  }

  if (monitorState.get(monitorId) !== state) return;

  const raw = await pingUrl(monitor.url, {
    method: monitor.method,
    headers: monitor.request_headers,
    body: monitor.request_body,
    keyword: monitor.keyword,
    keywordMode: monitor.keyword_mode,
    timeoutMs: monitor.timeout_ms,
  });
  // The monitor may have been edited, paused or deleted while the HTTP request
  // was in flight. Do not publish stale results or schedule another loop.
  if (monitorState.get(monitorId) !== state) return;

  // Override status based on expected_status
  const isExpected = raw.httpStatus === state.expectedStatus;
  const result = {
    ...raw,
    monitorId,
    url: monitor.url,
    status: (raw.httpStatus !== null && isExpected && !raw.failureReason) ? "up" : "down",
    failureReason: raw.failureReason || (raw.httpStatus !== null && !isExpected ? "status_mismatch" : undefined),
  };
  const maintenance = await getActiveMaintenance(monitorId).catch((err) => {
    console.error(`[Maintenance] ${err.message}`);
    return null;
  });
  if (maintenance) result.maintenance = true;

  state.checkCount++;
  totalAdaptiveChecks++;
  if (result.status === "down") state.consecutiveFailures++;
  else state.consecutiveFailures = 0;

  if (result.status !== "down") {
    state.readings.push(result.responseTime);
    if (state.readings.length > READINGS_WINDOW) state.readings.shift();
  }

  const anomaly  = result.status === "down"
    ? { isAnomaly: false, zScore: null }
    : detectAnomaly(state.readings.slice(0, -1), result.responseTime);
  result.anomaly = anomaly;

  await storeMetric(monitorId, result).catch((err) =>
    console.error(`[Storage] ${err.message}`)
  );
  if (!maintenance) {
    upsertCheckRollup(monitorId, result).catch((err) =>
      console.error(`[Rollup] ${err.message}`)
    );
  }

  if (anomaly.isAnomaly && !maintenance) {
    sendSlackAlert(monitor.url, result, anomaly.zScore);
    notify(monitor, "anomaly", result);
  }

  // ── Down alert + incident tracking ────────────────────────────────────────
  const wasDown = state.lastStatus === "down";
  const isDown  = result.status === "down";
  const isUp    = result.status === "up";

  const confirmedDown = !maintenance && isDown && state.consecutiveFailures >= state.failureThreshold;
  if (confirmedDown) {
    if (!wasDown) {
      state.downSince = new Date(result.timestamp).getTime();
      console.log(`[Incident] Outage started: monitor ${monitorId} (${monitor.url})`);
    }

    // Retry incident creation on subsequent confirmed-down checks if the
    // database was temporarily unavailable during the first outage check.
    if (!state.openIncidentId && state.downSince !== null) {
      try {
        const row = await openIncident({ monitorId, startedAt: state.downSince });
        if (row) {
          state.openIncidentId = row.id;
          state.downSince = new Date(row.started_at).getTime();
          getBroadcastIncidentUpdate()({
            type: "opened",
            monitorId,
            incidentId: row.id,
            startedAt: state.downSince,
          });
        }
      } catch (err) {
        console.error(`[Incident] openIncident failed: ${err.message}`);
      }
    }

    // Persist cooldowns in Redis so separate backend processes do not
    // independently send the same outage alert.
    const cooldownKey = `pulsewatch:cooldown:down:${monitorId}`;
    acquireCooldown(cooldownKey, DOWN_ALERT_COOLDOWN_MS)
      .then((acquired) => {
        if (!acquired) return;
        sendSlackAlert(monitor.url, result, null);
        notify(monitor, "down", result);
      })
      .catch((err) => {
        // Fail open: an outage notification is more important than suppressing
        // a duplicate when Redis is temporarily unavailable.
        console.error(`[AlertCooldown] Redis unavailable for monitor ${monitorId}: ${err.message}`);
        sendSlackAlert(monitor.url, result, null);
        notify(monitor, "down", result);
      });
  }

  // If incident persistence failed while the outage was active, create the
  // record before resolving it so the lifecycle is not silently lost.
  if (isUp && state.openIncidentId === null && state.downSince !== null) {
    try {
      const row = await openIncident({ monitorId, startedAt: state.downSince });
      if (row) state.openIncidentId = row.id;
    } catch (err) {
      console.error(`[Incident] recovery-time incident creation failed: ${err.message}`);
    }
  }

  if (isUp && state.openIncidentId !== null && state.downSince !== null) {
    const resolvedAt = new Date(result.timestamp).getTime();
    const startedAt = state.downSince;
    try {
      const row = await resolveIncident({ incidentId: state.openIncidentId, resolvedAt });
      if (row) {
        getBroadcastIncidentUpdate()({
          type: "resolved",
          monitorId,
          incidentId: row.id,
          resolvedAt: new Date(row.resolved_at).getTime(),
          durationMs: row.duration_ms,
        });
      }
      const durationSec = ((resolvedAt - startedAt) / 1000).toFixed(0);
      console.log(`[Incident] Resolved: monitor ${monitorId} — ${durationSec}s`);
      notify(monitor, "recovered", { ...result, downtimeMs: resolvedAt - startedAt });
      state.downSince = null;
      state.openIncidentId = null;
    } catch (err) {
      // Keep the incident state so the next healthy check retries resolution.
      console.error(`[Incident] resolveIncident failed: ${err.message}`);
    }
  }

  if (isUp && state.openIncidentId !== null && state.downSince !== null) {
    state.lastStatus = "down"; // DB resolution failed; retry on the next healthy check.
  } else if (isUp || confirmedDown) {
    state.lastStatus = result.status;
  }

  if (_onResultCb) _onResultCb(result, anomaly);

  const isProblematic = anomaly.isAnomaly || confirmedDown;
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

  if (monitorState.get(monitorId) === state) {
    state.timeoutHandle = setTimeout(() => {
      state.timeoutHandle = null;
      checkMonitor(monitorId);
    }, nextInterval);
  }
}

// Guard each monitor against overlapping checks and keep its loop alive if an
// unexpected dependency/runtime error escapes the normal ping error handling.
async function checkMonitor(monitorId) {
  const state = monitorState.get(monitorId);
  if (!state || state.checkInFlight) return;

  state.checkInFlight = true;
  try {
    await performMonitorCheck(monitorId);
  } catch (err) {
    console.error(`[Poller] monitor ${monitorId} check failed unexpectedly: ${err.message}`);
    // A failed check must not permanently stop monitoring this endpoint.
    if (monitorState.get(monitorId) === state && !state.timeoutHandle) {
      state.timeoutHandle = setTimeout(() => {
        state.timeoutHandle = null;
        checkMonitor(monitorId);
      }, state.baseIntervalMs);
    }
  } finally {
    state.checkInFlight = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function startPolling() {
  pollingStartTime = Date.now();
  totalAdaptiveChecks = 0;
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

  if (comparisonTimer) clearInterval(comparisonTimer);
  comparisonTimer = setInterval(logComparisonStats, 5 * 60 * 1000);
  if (sslTimer) clearInterval(sslTimer);
  sslTimer = setInterval(() => {
    for (const monitor of getActiveMonitors()) checkSsl(monitor);
  }, 60 * 60 * 1000);
  for (const monitor of monitors) checkSsl(monitor);
  deleteOldRollups().catch((err) => console.error(`[Rollup] cleanup failed: ${err.message}`));
}

function stopPolling() {
  if (comparisonTimer) {
    clearInterval(comparisonTimer);
    comparisonTimer = null;
  }
  if (sslTimer) {
    clearInterval(sslTimer);
    sslTimer = null;
  }
  for (const [, s] of monitorState) {
    if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
  }
  monitorState.clear();
}

function logComparisonStats() {
  if (!pollingStartTime) return;
  const elapsedMs = Date.now() - pollingStartTime;
  const elapsedSec = elapsedMs / 1000;
  const states = [...monitorState.entries()];
  const adaptiveChecks = states.reduce((sum, [, state]) => sum + state.checkCount, 0);
  const fixedTotal = states.reduce((sum, [, state]) => (
    sum + Math.floor(elapsedMs / Math.max(1, state.baseIntervalMs))
  ), 0);
  const saved = fixedTotal - adaptiveChecks;
  const pct = fixedTotal > 0 ? ((saved / fixedTotal) * 100).toFixed(1) : "0.0";
  console.log("─".repeat(60));
  console.log(`[Adaptive Polling] ${(elapsedSec / 60).toFixed(1)}min | adaptive=${adaptiveChecks} | fixed=${fixedTotal} | saved=${pct}%`);
  for (const [id, state] of states) {
    console.log(`  monitor ${id}: ${state.checkCount} checks, interval=${(state.currentIntervalMs / 1000).toFixed(0)}s`);
  }
  console.log("─".repeat(60));
}

function getPollingState(userId = null, isAdmin = true) {
  const visibleEntries = [...monitorState.entries()].filter(([id]) => {
    if (userId === null || isAdmin) return true;
    return getMonitorsForUser(userId, false).some((monitor) => monitor.id === id);
  });
  const monitorCount = visibleEntries.length;
  const scopedChecks = visibleEntries.reduce((sum, [, state]) => sum + state.checkCount, 0);
  const elapsedMs = pollingStartTime ? Date.now() - pollingStartTime : 0;
  const fixedTotal = visibleEntries.reduce((sum, [, state]) => (
    sum + Math.floor(elapsedMs / Math.max(1, state.baseIntervalMs))
  ), 0);
  const saved = fixedTotal - scopedChecks;

  return {
    monitorCount,
    totalAdaptiveChecks: scopedChecks,
    fixedTotalChecks: fixedTotal,
    savedPct: fixedTotal > 0 ? parseFloat(((saved / fixedTotal) * 100).toFixed(1)) : 0,
    monitorIntervals: Object.fromEntries(
      visibleEntries.map(([id, state]) => [id, state.currentIntervalMs])
    ),
  };
}

function getSslState(monitorId) {
  const state = monitorState.get(Number(monitorId)) || monitorState.get(String(monitorId));
  return state
    ? { sslExpiresAt: state.sslExpiresAt, sslDaysLeft: state.sslDaysLeft }
    : { sslExpiresAt: null, sslDaysLeft: null };
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
  getSslState,
  // Expose for tests
  _monitorState: monitorState,
};
