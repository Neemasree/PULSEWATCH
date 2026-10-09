/**
 * authRedis.test.js
 * Verifies that refresh-token blacklisting and account lockout counters
 * persist in Redis and survive simulated process restarts.
 */

require("dotenv").config();

const { client: redisClient } = require("../redisClient");
const {
  blacklist,
  isBlacklisted,
  checkLockout,
  recordFailure,
  clearFailures,
} = require("../auth");

describe("Redis-backed Auth State", () => {
  const testJti = `test-jti-${Date.now()}`;
  const testUser = `lockout_user_${Date.now()}`;

  afterAll(async () => {
    // Cleanup Redis keys
    await redisClient.del(
      `auth:blacklist:${testJti}`,
      `auth:fails:${testUser}`,
      `auth:lockout:${testUser}`
    );
    redisClient.disconnect();
  });

  describe("Refresh token JTI blacklist in Redis", () => {
    test("blacklists a token JTI and verifies it exists in Redis", async () => {
      // 10 minutes in the future
      const expMs = Date.now() + 10 * 60 * 1000;
      await blacklist(testJti, expMs);

      const blacklisted = await isBlacklisted(testJti);
      expect(blacklisted).toBe(true);

      // Verify TTL in Redis
      const ttl = await redisClient.ttl(`auth:blacklist:${testJti}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    test("blacklist state survives a simulated process restart (fresh require)", async () => {
      // Clear Node require cache for auth to simulate fresh process
      delete require.cache[require.resolve("../auth")];
      const freshAuth = require("../auth");

      const stillBlacklisted = await freshAuth.isBlacklisted(testJti);
      expect(stillBlacklisted).toBe(true);
    });

    test("unblacklisted JTI returns false", async () => {
      const isNot = await isBlacklisted("non-existent-jti-xyz");
      expect(isNot).toBe(false);
    });
  });

  describe("Account lockout in Redis", () => {
    test("locks out account after 5 consecutive failures", async () => {
      // First 4 failures do not lock out
      for (let i = 0; i < 4; i++) {
        await recordFailure(testUser);
        const lockMsg = await checkLockout(testUser);
        expect(lockMsg).toBeNull();
      }

      // 5th failure triggers lockout
      await recordFailure(testUser);
      const lockMsg = await checkLockout(testUser);
      expect(lockMsg).toMatch(/Account locked\. Try again in \d+s\./);

      const ttl = await redisClient.ttl(`auth:lockout:${testUser}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    });

    test("lockout persists across a simulated process restart", async () => {
      delete require.cache[require.resolve("../auth")];
      const freshAuth = require("../auth");

      const lockMsg = await freshAuth.checkLockout(testUser);
      expect(lockMsg).toMatch(/Account locked\. Try again in \d+s\./);
    });

    test("clearFailures removes lockout and counter keys from Redis", async () => {
      await clearFailures(testUser);

      const lockMsg = await checkLockout(testUser);
      expect(lockMsg).toBeNull();

      const exists = await redisClient.exists(`auth:lockout:${testUser}`);
      expect(exists).toBe(0);
    });
  });
});
