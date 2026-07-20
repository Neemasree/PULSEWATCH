/**
 * endpointRegistry.js
 * Manages the set of monitored URLs at runtime.
 *
 * Starts with a hardcoded seed list. Admins can add/remove URLs via the
 * REST API without restarting the server — changes take effect immediately
 * in the polling loop.
 *
 * In production this would be persisted to Redis or a database so URLs
 * survive a restart. For this project, in-memory is fine and honestly
 * more honest for an interview than faking persistence.
 */

const EventEmitter = require("events");

const registry = new EventEmitter();

// ─── Initial seed list ────────────────────────────────────────────────────────
const _urls = new Set([
  "https://www.google.com",
  "https://www.github.com",
  "https://www.cloudflare.com",
  "https://httpbin.org/get",
  "https://jsonplaceholder.typicode.com/posts/1",
]);

/**
 * Returns a snapshot array of currently monitored URLs.
 * @returns {string[]}
 */
function getUrls() {
  return [..._urls];
}

/**
 * Adds a URL to the monitored set.
 * Emits "added" event so the poller can start checking it immediately.
 * @param {string} url
 * @returns {boolean} true if newly added, false if already present
 */
function addUrl(url) {
  if (_urls.has(url)) return false;
  _urls.add(url);
  registry.emit("added", url);
  return true;
}

/**
 * Removes a URL from the monitored set.
 * Emits "removed" event so the poller can stop checking it.
 * @param {string} url
 * @returns {boolean} true if removed, false if wasn't present
 */
function removeUrl(url) {
  if (!_urls.has(url)) return false;
  _urls.delete(url);
  registry.emit("removed", url);
  return true;
}

module.exports = { getUrls, addUrl, removeUrl, registry };
