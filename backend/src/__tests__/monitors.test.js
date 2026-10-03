/**
 * monitors.test.js
 * Comprehensive integration tests for /api/monitors:
 *   - CRUD happy paths
 *   - Zod validation failures
 *   - SSRF rejection (localhost, private subnets, metadata)
 *   - Per-user monitor limits
 *   - Strict cross-user isolation (User A vs User B) + Admin access
 */

require("dotenv").config();
const request = require("supertest");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { app } = require("../index");
const { client: redisClient } = require("../redisClient");

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "pw-access-dev-secret-change-in-prod";

function createAuthContext(user) {
  const token = jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role, name: user.name },
    ACCESS_SECRET,
    { expiresIn: "15m" }
  );
  const csrfToken = `csrf-${user.id}-${Date.now()}`;
  const cookieHeader = `access_token=${token}; csrf_token=${csrfToken}`;

  return {
    token,
    csrfToken,
    cookieHeader,
    attach: (req) =>
      req.set("Cookie", cookieHeader).set("x-csrf-token", csrfToken),
  };
}

describe("Monitors API (/api/monitors)", () => {
  let userA, userB, adminUser;
  let authA, authB, authAdmin;

  beforeAll(async () => {
    // Seed test users in Postgres
    const resA = await pool.query(`
      INSERT INTO users (username, password_hash, role, name)
      VALUES ('test_mon_a_${Date.now()}', 'hash', 'guest', 'User A')
      RETURNING id, username, role, name;
    `);
    userA = resA.rows[0];

    const resB = await pool.query(`
      INSERT INTO users (username, password_hash, role, name)
      VALUES ('test_mon_b_${Date.now()}', 'hash', 'guest', 'User B')
      RETURNING id, username, role, name;
    `);
    userB = resB.rows[0];

    const resAdmin = await pool.query(`
      INSERT INTO users (username, password_hash, role, name)
      VALUES ('test_mon_admin_${Date.now()}', 'hash', 'admin', 'Admin')
      RETURNING id, username, role, name;
    `);
    adminUser = resAdmin.rows[0];

    authA = createAuthContext(userA);
    authB = createAuthContext(userB);
    authAdmin = createAuthContext(adminUser);
  });

  afterAll(async () => {
    // Cleanup test users and cascade-delete their monitors
    if (userA) await pool.query("DELETE FROM users WHERE id = $1", [userA.id]);
    if (userB) await pool.query("DELETE FROM users WHERE id = $1", [userB.id]);
    if (adminUser) await pool.query("DELETE FROM users WHERE id = $1", [adminUser.id]);
    await pool.end().catch(() => {});
    await redisClient.quit().catch(() => {});
  });

  describe("CRUD Happy Paths", () => {
    let createdMonitorId;

    test("User A can create a monitor (POST /api/monitors)", async () => {
      const payload = {
        name: "User A Google Check",
        url: "https://www.google.com",
        interval_seconds: 15,
        expected_status: 200,
        is_public: false,
      };

      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send(payload)
        .expect(201);

      expect(res.body.monitor).toBeDefined();
      expect(res.body.monitor.name).toBe(payload.name);
      expect(res.body.monitor.url).toBe(payload.url);
      expect(res.body.monitor.interval_seconds).toBe(15);
      expect(res.body.monitor.user_id).toBe(userA.id);
      expect(res.body.monitor.enabled).toBe(true);

      createdMonitorId = res.body.monitor.id;
    });

    test("User A can list their monitors (GET /api/monitors)", async () => {
      const res = await authA
        .attach(request(app).get("/api/monitors"))
        .expect(200);

      expect(Array.isArray(res.body.monitors)).toBe(true);
      const found = res.body.monitors.find((m) => m.id === createdMonitorId);
      expect(found).toBeDefined();
      expect(found.name).toBe("User A Google Check");
    });

    test("User A can get details of their monitor (GET /api/monitors/:id)", async () => {
      const res = await authA
        .attach(request(app).get(`/api/monitors/${createdMonitorId}`))
        .expect(200);

      expect(res.body.monitor.id).toBe(createdMonitorId);
      expect(res.body.monitor.name).toBe("User A Google Check");
    });

    test("User A can update their monitor (PATCH /api/monitors/:id)", async () => {
      const res = await authA
        .attach(request(app).patch(`/api/monitors/${createdMonitorId}`))
        .send({ name: "Updated Google Name", interval_seconds: 30 })
        .expect(200);

      expect(res.body.monitor.name).toBe("Updated Google Name");
      expect(res.body.monitor.interval_seconds).toBe(30);
    });

    test("User A can pause their monitor (POST /api/monitors/:id/pause)", async () => {
      const res = await authA
        .attach(request(app).post(`/api/monitors/${createdMonitorId}/pause`))
        .expect(200);

      expect(res.body.monitor.enabled).toBe(false);
    });

    test("User A can resume their monitor (POST /api/monitors/:id/resume)", async () => {
      const res = await authA
        .attach(request(app).post(`/api/monitors/${createdMonitorId}/resume`))
        .expect(200);

      expect(res.body.monitor.enabled).toBe(true);
    });

    test("User A can delete their monitor (DELETE /api/monitors/:id)", async () => {
      await authA
        .attach(request(app).delete(`/api/monitors/${createdMonitorId}`))
        .expect(200);

      // Verify it's gone
      await authA
        .attach(request(app).get(`/api/monitors/${createdMonitorId}`))
        .expect(404);
    });
  });

  describe("Validation Failures (Zod)", () => {
    test("rejects invalid URL format", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Bad URL", url: "not-a-valid-url" })
        .expect(400);

      expect(res.body.error).toMatch(/Invalid URL format/i);
    });

    test("rejects empty name", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "   ", url: "https://example.com" })
        .expect(400);

      expect(res.body.error).toMatch(/Name must not be empty/i);
    });

    test("rejects interval < 5 seconds", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Too Fast", url: "https://example.com", interval_seconds: 3 })
        .expect(400);

      expect(res.body.error).toMatch(/Interval must be >= 5s/i);
    });

    test("rejects interval > 3600 seconds", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Too Slow", url: "https://example.com", interval_seconds: 5000 })
        .expect(400);

      expect(res.body.error).toMatch(/Interval must be <= 3600s/i);
    });

    test("rejects invalid expected status", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Bad Status", url: "https://example.com", expected_status: 999 })
        .expect(400);

      expect(res.body.error).toMatch(/Status must be <= 599/i);
    });
  });

  describe("SSRF Rejection", () => {
    test("rejects localhost", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Localhost", url: "http://localhost:3000/api" })
        .expect(400);

      expect(res.body.error).toMatch(/SSRF/i);
    });

    test("rejects 127.0.0.1 loopback IP", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Loopback", url: "http://127.0.0.1:8080" })
        .expect(400);

      expect(res.body.error).toMatch(/SSRF/i);
    });

    test("rejects cloud metadata IP (169.254.169.254)", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "AWS Metadata", url: "http://169.254.169.254/latest/meta-data/" })
        .expect(400);

      expect(res.body.error).toMatch(/SSRF/i);
    });

    test("rejects 192.168.x.x private network IP", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Home Router", url: "http://192.168.1.1" })
        .expect(400);

      expect(res.body.error).toMatch(/SSRF/i);
    });

    test("rejects 10.x.x.x private network IP", async () => {
      const res = await authA
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Private 10", url: "http://10.0.0.1" })
        .expect(400);

      expect(res.body.error).toMatch(/SSRF/i);
    });
  });

  describe("Ownership Isolation", () => {
    let monitorBId;

    beforeAll(async () => {
      // Create a monitor owned by User B
      const res = await authB
        .attach(request(app).post("/api/monitors"))
        .send({
          name: "User B Private Monitor",
          url: "https://www.github.com",
        })
        .expect(201);

      monitorBId = res.body.monitor.id;
    });

    test("User A cannot read User B's monitor (GET /api/monitors/:id -> 404)", async () => {
      await authA
        .attach(request(app).get(`/api/monitors/${monitorBId}`))
        .expect(404);
    });

    test("User A does not see User B's monitor in listing (GET /api/monitors)", async () => {
      const res = await authA
        .attach(request(app).get("/api/monitors"))
        .expect(200);

      const found = res.body.monitors.find((m) => m.id === monitorBId);
      expect(found).toBeUndefined();
    });

    test("User A cannot edit User B's monitor (PATCH /api/monitors/:id -> 404)", async () => {
      await authA
        .attach(request(app).patch(`/api/monitors/${monitorBId}`))
        .send({ name: "Hacked by User A" })
        .expect(404);

      // Verify name was not changed
      const res = await authB
        .attach(request(app).get(`/api/monitors/${monitorBId}`))
        .expect(200);
      expect(res.body.monitor.name).toBe("User B Private Monitor");
    });

    test("User A cannot pause User B's monitor (POST /api/monitors/:id/pause -> 404)", async () => {
      await authA
        .attach(request(app).post(`/api/monitors/${monitorBId}/pause`))
        .expect(404);
    });

    test("User A cannot resume User B's monitor (POST /api/monitors/:id/resume -> 404)", async () => {
      await authA
        .attach(request(app).post(`/api/monitors/${monitorBId}/resume`))
        .expect(404);
    });

    test("User A cannot delete User B's monitor (DELETE /api/monitors/:id -> 404)", async () => {
      await authA
        .attach(request(app).delete(`/api/monitors/${monitorBId}`))
        .expect(404);

      // Verify User B's monitor still exists
      await authB
        .attach(request(app).get(`/api/monitors/${monitorBId}`))
        .expect(200);
    });

    test("Admin CAN view User B's monitor (GET /api/monitors/:id -> 200)", async () => {
      const res = await authAdmin
        .attach(request(app).get(`/api/monitors/${monitorBId}`))
        .expect(200);

      expect(res.body.monitor.id).toBe(monitorBId);
      expect(res.body.monitor.user_id).toBe(userB.id);
    });

    test("Admin lists all monitors across all users (GET /api/monitors)", async () => {
      const res = await authAdmin
        .attach(request(app).get("/api/monitors"))
        .expect(200);

      const found = res.body.monitors.find((m) => m.id === monitorBId);
      expect(found).toBeDefined();
    });

    test("Admin CAN pause User B's monitor (POST /api/monitors/:id/pause -> 200)", async () => {
      const res = await authAdmin
        .attach(request(app).post(`/api/monitors/${monitorBId}/pause`))
        .expect(200);

      expect(res.body.monitor.enabled).toBe(false);
    });
  });

  describe("Per-user Monitor Limit Enforcement", () => {
    test("rejects creation when MAX_MONITORS_PER_USER is reached", async () => {
      process.env.MAX_MONITORS_PER_USER = "2";

      // User B already has 1 monitor. Add a 2nd:
      await authB
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Monitor 2", url: "https://www.cloudflare.com" })
        .expect(201);

      // Attempt 3rd: should fail limit
      const res = await authB
        .attach(request(app).post("/api/monitors"))
        .send({ name: "Monitor 3 Exceeds", url: "https://httpbin.org/get" })
        .expect(400);

      expect(res.body.error).toMatch(/Monitor limit reached/i);

      delete process.env.MAX_MONITORS_PER_USER;
    });
  });
});
