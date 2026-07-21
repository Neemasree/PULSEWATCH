/**
 * redisClient.js  (Phase 2.1)
 * ioredis connection factory — reads host/port from environment variables
 * so the same code works locally, in Docker, and on cloud platforms like Upstash.
 *
 * Exports:
 *   client          — the raw ioredis instance (for one-off commands)
 *   storeMetric     — save a ping result into a sorted set
 *   getRecentMetrics — fetch the last N results for a URL
 *
 * Storage design: one Redis sorted set per URL.
 *   Key:   metrics:<sanitised-url>
 *   Score: Unix timestamp in ms  ← keeps entries ordered by time automatically
 *   Value: JSON-serialised result object
 *
 * Why sorted sets and not plain strings?
 *   ZADD + ZREVRANGE gives us "last N results ordered by time" in a single
 *   O(log N) call. With plain SET we'd have to maintain a separate index.
 */

const Redis = require("ioredis");

const TTL_SECONDS = 7 * 24 * 3600; // 7 days — keeps enough history for the status page uptime bars

// Support both individual host/port vars (local/Docker) and a single
// connection string (Upstash: redis://:<password>@host:port)
function createClient() {
  const redisUrl = process.env.REDIS_URL;

  const client = redisUrl
    ? new Redis(redisUrl, { tls: redisUrl.startsWith("rediss://") ? {} : undefined })
    : new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379", 10),
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });

  client.on("connect", () => console.log("[Redis] Connected"));
  client.on("error", (err) => console.error("[Redis] Error:", err.message));

  return client;
}

const client = createClient();

/**
 * Sanitises a URL into a safe Redis key segment.
 * "https://example.com/path?q=1" → "metrics:example.com/path"
 */
function urlToKey(url) {
  return `metrics:${url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "")}`;
}

/**
 * Stores one ping result in the sorted set for that URL.
 * Also slides the TTL forward so active keys never expire mid-run.
 *
 * @param {string} url     The monitored URL
 * @param {object} result  The ping result object from pinger.js
 */
async function storeMetric(url, result) {
  const key = urlToKey(url);
  const score = new Date(result.timestamp).getTime(); // ms timestamp as sort score

  // Pipeline = one network round-trip for all three commands
  const pipeline = client.pipeline();
  pipeline.zadd(key, score, JSON.stringify(result));
  pipeline.zremrangebyrank(key, 0, -501); // keep newest 500 entries
  pipeline.expire(key, TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Returns the most recent `count` results for a URL, newest first.
 *
 * @param {string} url
 * @param {number} count  Default 20
 * @returns {Promise<object[]>}
 */
async function getRecentMetrics(url, count = 20) {
  const key = urlToKey(url);
  const raw = await client.zrevrange(key, 0, count - 1);
  return raw.map((item) => JSON.parse(item));
}

/**
 * Buckets all stored results for a URL into hourly slots.
 * Returns an array of `numHours` entries, index 0 = oldest, index N-1 = most recent.
 * Each entry is "up" | "down" | "unknown" based on the majority status in that hour.
 *
 * Used by the public status page to render real uptime history bars.
 *
 * @param {string} url
 * @param {number} numHours  How many hourly buckets to return (default 90 × 24 = 2160 is too many; we use 90 to match the 90-bar display)
 * @returns {Promise<Array<"up"|"down"|"unknown">>}
 */
async function getHourlyBuckets(url, numHours = 90) {
  const key = urlToKey(url);
  // Fetch all stored entries within the window
  const windowMs = numHours * 60 * 60 * 1000;
  const since    = Date.now() - windowMs;

  // ZRANGEBYSCORE returns entries ordered oldest→newest within the time range
  const raw = await client.zrangebyscore(key, since, "+inf");
  const results = raw.map((item) => JSON.parse(item));

  // Build a map: hourSlot (floor to hour) → { up, down }
  const buckets = new Map();
  for (const r of results) {
    const ts   = new Date(r.timestamp).getTime();
    const slot = Math.floor(ts / (60 * 60 * 1000)); // hour number
    if (!buckets.has(slot)) buckets.set(slot, { up: 0, down: 0 });
    const b = buckets.get(slot);
    if (r.status === "up") b.up++;
    else b.down++;
  }

  // Build the output array — one entry per hour slot from oldest to newest
  const nowSlot   = Math.floor(Date.now() / (60 * 60 * 1000));
  const startSlot = nowSlot - numHours + 1;
  const output = [];

  for (let slot = startSlot; slot <= nowSlot; slot++) {
    const b = buckets.get(slot);
    if (!b)           output.push("unknown"); // no data for this hour
    else if (b.up > b.down) output.push("up");
    else              output.push("down");
  }

  return output;
}

module.exports = { client, storeMetric, getRecentMetrics, getHourlyBuckets, urlToKey };

// ── Incident storage ──────────────────────────────────────────────────────────
// Key scheme: incidents:<sanitised-url>
// Sorted set, score = resolvedAt timestamp ms (ongoing incidents not stored here
// until they resolve — they live in-memory in poller.js and are merged at query time).

const INCIDENT_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const MAX_INCIDENTS        = 50;              // per URL

/**
 * Converts a URL into a Redis key for incident storage.
 * "https://example.com/path" → "incidents:example.com/path"
 */
function urlToIncidentKey(url) {
  return `incidents:${url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "")}`;
}

/**
 * Persists a resolved incident record to Redis.
 *
 * @param {{ url, startedAt, resolvedAt, durationMs }} incident
 */
async function storeIncident(incident) {
  const key   = urlToIncidentKey(incident.url);
  const score = incident.resolvedAt; // ms timestamp — sorts chronologically

  const pipeline = client.pipeline();
  pipeline.zadd(key, score, JSON.stringify(incident));
  pipeline.zremrangebyrank(key, 0, -(MAX_INCIDENTS + 1)); // keep newest 50
  pipeline.expire(key, INCIDENT_TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Returns the most recent `count` resolved incidents for a URL, newest first.
 *
 * @param {string} url
 * @param {number} count
 * @returns {Promise<object[]>}
 */
async function getIncidents(url, count = 20) {
  const key = urlToIncidentKey(url);
  const raw = await client.zrevrange(key, 0, count - 1);
  return raw.map((item) => JSON.parse(item));
}

// Re-export with incident helpers appended
Object.assign(module.exports, { storeIncident, getIncidents, urlToIncidentKey });
