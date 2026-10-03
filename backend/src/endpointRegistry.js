/**
 * endpointRegistry.js
 * In-memory cache of ALL monitors (enabled and paused), loaded from Postgres
 * on startup and kept in sync via notify* calls from the router.
 *
 * Key changes in Phase 1.5:
 *   - _monitors holds ALL monitors (enabled + paused) so ownership checks
 *     work for paused monitors too.
 *   - registry events pass the full monitor object, not just a URL string,
 *     so the poller can read interval_seconds and expected_status.
 *   - getMonitorsForUser(userId, isAdmin) replaces getUrlsForUser — returns
 *     monitor objects, not URL strings, so callers can use monitorId.
 */

const EventEmitter = require("events");
const { getAllEnabledMonitors } = require("./db/monitors");

const registry = new EventEmitter();

// Map<monitorId, monitor> — ALL monitors (enabled + paused)
const _monitors = new Map();

async function loadFromDb() {
  try {
    // Load only enabled monitors into the active set on startup.
    // Paused monitors are added lazily when the router calls notifyMonitorAdded.
    const monitors = await getAllEnabledMonitors();
    _monitors.clear();
    for (const m of monitors) _monitors.set(m.id, m);
    console.log(`[Registry] Loaded ${_monitors.size} enabled monitors from database.`);
  } catch (err) {
    console.error("[Registry] Failed to load monitors from DB:", err.message);
  }
}

/** All monitor objects currently in the cache (enabled + paused). */
function getAllMonitors() {
  return [..._monitors.values()];
}

/** Only enabled monitors. */
function getActiveMonitors() {
  return [..._monitors.values()].filter((m) => m.enabled);
}

/** Unique URLs across all enabled monitors. */
function getUrls() {
  return [...new Set(getActiveMonitors().map((m) => m.url))];
}

/** Unique URLs across enabled + public monitors. */
function getPublicUrls() {
  return [...new Set(
    getActiveMonitors().filter((m) => m.is_public).map((m) => m.url)
  )];
}

/** Public monitor objects (enabled + is_public). */
function getPublicMonitors() {
  return getActiveMonitors().filter((m) => m.is_public);
}

/**
 * Returns monitor objects visible to this user:
 *   - admin  → all monitors in the cache (enabled + paused)
 *   - guest  → only monitors owned by this user (enabled + paused)
 *
 * Includes paused monitors so /api/status and /api/history work for them.
 */
function getMonitorsForUser(userId, isAdmin) {
  if (isAdmin) return getAllMonitors();
  const uid = String(userId);
  return getAllMonitors().filter((m) => String(m.user_id) === uid);
}

/**
 * Called when a monitor is created or resumed.
 * Adds to cache; emits "added" with the monitor object if it was enabled.
 */
function notifyMonitorAdded(monitor) {
  if (!monitor) return;
  _monitors.set(monitor.id, monitor);
  if (monitor.enabled) {
    registry.emit("added", monitor);
  }
}

/**
 * Called when a monitor is deleted.
 * Removes from cache; emits "removed" with the monitor object.
 */
function notifyMonitorRemoved(monitor) {
  if (!monitor) return;
  _monitors.delete(monitor.id);
  registry.emit("removed", monitor);
}

/**
 * Called on PATCH (edit, pause, resume).
 * Updates cache; emits "removed" for prev then "added" for next if enabled.
 * Passes both objects so the poller can decide whether to reset adaptive state.
 */
function notifyMonitorUpdated(prevMonitor, newMonitor) {
  if (prevMonitor) {
    // Remove old entry from cache and stop its loop
    _monitors.delete(prevMonitor.id);
    registry.emit("removed", prevMonitor);
  }
  if (newMonitor) {
    _monitors.set(newMonitor.id, newMonitor);
    if (newMonitor.enabled) {
      // Pass prev so poller can decide whether to reset adaptive state
      registry.emit("added", newMonitor, prevMonitor);
    }
  }
}

module.exports = {
  registry,
  loadFromDb,
  getAllMonitors,
  getActiveMonitors,
  getUrls,
  getPublicUrls,
  getPublicMonitors,
  getMonitorsForUser,
  notifyMonitorAdded,
  notifyMonitorRemoved,
  notifyMonitorUpdated,
};
