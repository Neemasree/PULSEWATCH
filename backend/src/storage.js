/**
 * storage.js
 * Redis-backed time-series storage for ping results.
 *
 * Why Redis sorted sets?
 *   A sorted set stores members (JSON blobs) each with a numeric SCORE.
 *   We use the Unix timestamp as the score, which means:
 *   - Items are always ordered chronologically for free
 *   - Range queries ("give me results between time A and time B") are O(log N)
 *   - "Last N results" is a single ZREVRANGE call — no scanning or sorting needed
 *
 * Why not an in-memory JS array?
 *   - Data dies when the process restarts
 *   - Multiple server instances can't share it (horizontal scaling breaks)
 *   - Redis is purpose-built for this access pattern and handles TTL natively
 */

const Redis = require("ioredis");

// TTL for the entire key — 1 hour in seconds.
// After the last write, if the key isn't touched, Redis auto-deletes it.
const TTL_SECONDS = 60 * 60; // 1 hour

// Max readings to store per URL (keeps the sorted set bounded)
const MAX_ENTRIES_PER_URL = 500;

let redisClient = null;

/**
 * Returns a shared Redis client. Creates it on first call.
 * @returns {Redis}
 */
function getClient() {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      // Reconnect automatically — don't crash the app on a blip
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: false,
    });

    redisClient.on("connect", () => console.log("[Redis] Connected"));
    redisClient.on("error", (err) => console.error("[Redis] Error:", err.message));
  }
  return redisClient;
}

/**
 * Converts a URL into a safe Redis key.
 * e.g. "https://example.com/path" → "pulsewatch:https://example.com/path"
 */
function urlToKey(url) {
  return `pulsewatch:${url}`;
}

/**
 * Persists a single ping result to Redis.
 * Uses a pipeline (atomic batch) to do all operations in one round-trip.
 *
 * @param {object} result  The ping result object from pinger.js
 */
async function saveResult(result) {
  const client = getClient();
  const key = urlToKey(result.url);
  const score = new Date(result.timestamp).getTime(); // Unix ms as sort score
  const member = JSON.stringify(result);

  const pipeline = client.pipeline();

  // ZADD key score member — insert into sorted set
  pipeline.zadd(key, score, member);

  // ZREMRANGEBYRANK — trim to MAX_ENTRIES oldest entries so the set never grows unbounded
  // Rank 0 is the lowest score (oldest). We keep the most recent MAX_ENTRIES.
  pipeline.zremrangebyrank(key, 0, -(MAX_ENTRIES_PER_URL + 1));

  // EXPIRE — slide the TTL window forward every time we write. The key expires
  // 1 hour after the LAST write, not the first — so active URLs stay in Redis.
  pipeline.expire(key, TTL_SECONDS);

  await pipeline.exec();
}

/**
 * Fetches the most recent N results for a given URL, newest first.
 *
 * @param {string} url
 * @param {number} n  How many results to return (default 20)
 * @returns {Promise<object[]>}
 */
async function getRecentResults(url, n = 20) {
  const client = getClient();
  const key = urlToKey(url);

  // ZREVRANGE returns members in descending score order (newest first)
  const raw = await client.zrevrange(key, 0, n - 1);
  return raw.map((item) => JSON.parse(item));
}

/**
 * Fetches results for all tracked URLs, returning a map of url → results[].
 * Used to hydrate new WebSocket clients with full history.
 *
 * @param {string[]} urls
 * @param {number}   n  Results per URL
 * @returns {Promise<Record<string, object[]>>}
 */
async function getAllRecentResults(urls, n = 20) {
  const entries = await Promise.all(
    urls.map(async (url) => [url, await getRecentResults(url, n)])
  );
  return Object.fromEntries(entries);
}

/**
 * Gracefully closes the Redis connection (used on shutdown).
 */
async function disconnect() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

module.exports = { saveResult, getRecentResults, getAllRecentResults, disconnect, getClient };
