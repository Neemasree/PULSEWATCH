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

const TTL_SECONDS = 3600; // 1 hour — old data expires automatically

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

module.exports = { client, storeMetric, getRecentMetrics, urlToKey };
