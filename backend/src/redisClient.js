/**
 * redisClient.js
 * ioredis connection + time-series storage, keyed by monitor ID.
 *
 * Key scheme (Phase 1.5):
 *   metrics:<monitorId>   — sorted set of ping results
 *   incidents:<monitorId> — sorted set of resolved incidents
 *
 * Keying by monitor ID (not URL) means two monitors pointing at the same
 * URL have completely independent histories, and deleting one never
 * corrupts the other's data.
 */

const Redis = require("ioredis");

const TTL_SECONDS          = 7 * 24 * 3600;  // 7 days
const INCIDENT_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const MAX_INCIDENTS        = 50;

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
  client.on("error",   (err) => console.error("[Redis] Error:", err.message));
  return client;
}

const client = createClient();

/** metrics:<monitorId> */
function monitorMetricKey(monitorId) {
  return `metrics:${monitorId}`;
}

/** incidents:<monitorId> */
function monitorIncidentKey(monitorId) {
  return `incidents:${monitorId}`;
}

/**
 * Stores one ping result for a monitor.
 * @param {number|string} monitorId
 * @param {object} result  ping result from pinger.js (must include timestamp)
 */
async function storeMetric(monitorId, result) {
  const key   = monitorMetricKey(monitorId);
  const score = new Date(result.timestamp).getTime();
  const pipeline = client.pipeline();
  pipeline.zadd(key, score, JSON.stringify(result));
  pipeline.zremrangebyrank(key, 0, -501); // keep newest 500
  pipeline.expire(key, TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Returns the most recent `count` results for a monitor, newest first.
 * @param {number|string} monitorId
 * @param {number} count
 */
async function getRecentMetrics(monitorId, count = 20) {
  const key = monitorMetricKey(monitorId);
  const raw = await client.zrevrange(key, 0, count - 1);
  return raw.map((item) => JSON.parse(item));
}

/**
 * Buckets stored results into hourly slots for the uptime bar display.
 * Returns array of `numHours` entries ("up"|"down"|"unknown"), oldest→newest.
 * @param {number|string} monitorId
 * @param {number} numHours
 */
async function getHourlyBuckets(monitorId, numHours = 90) {
  const key       = monitorMetricKey(monitorId);
  const windowMs  = numHours * 60 * 60 * 1000;
  const since     = Date.now() - windowMs;
  const raw       = await client.zrangebyscore(key, since, "+inf");
  const results   = raw.map((item) => JSON.parse(item));

  const buckets = new Map();
  for (const r of results) {
    const slot = Math.floor(new Date(r.timestamp).getTime() / (60 * 60 * 1000));
    if (!buckets.has(slot)) buckets.set(slot, { up: 0, down: 0 });
    const b = buckets.get(slot);
    if (r.status === "up") b.up++; else b.down++;
  }

  const nowSlot   = Math.floor(Date.now() / (60 * 60 * 1000));
  const startSlot = nowSlot - numHours + 1;
  const output    = [];
  for (let slot = startSlot; slot <= nowSlot; slot++) {
    const b = buckets.get(slot);
    if (!b)              output.push("unknown");
    else if (b.up > b.down) output.push("up");
    else                 output.push("down");
  }
  return output;
}

/**
 * Persists a resolved incident.
 * @param {{ monitorId, url, startedAt, resolvedAt, durationMs }} incident
 */
async function storeIncident(incident) {
  const key      = monitorIncidentKey(incident.monitorId);
  const score    = incident.resolvedAt;
  const pipeline = client.pipeline();
  pipeline.zadd(key, score, JSON.stringify(incident));
  pipeline.zremrangebyrank(key, 0, -(MAX_INCIDENTS + 1));
  pipeline.expire(key, INCIDENT_TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Returns the most recent `count` resolved incidents for a monitor, newest first.
 * @param {number|string} monitorId
 * @param {number} count
 */
async function getIncidents(monitorId, count = 20) {
  const key = monitorIncidentKey(monitorId);
  const raw = await client.zrevrange(key, 0, count - 1);
  return raw.map((item) => JSON.parse(item));
}

module.exports = {
  client,
  storeMetric,
  getRecentMetrics,
  getHourlyBuckets,
  storeIncident,
  getIncidents,
  monitorMetricKey,
  monitorIncidentKey,
};
