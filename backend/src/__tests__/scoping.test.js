/**
 * scoping.test.js
 *
 * Phase 1 gap tests, updated for Phase 1.5 monitorId-keyed API:
 *
 *  1. Poller driven by Postgres — registry event contract
 *  2. GET /api/public/* returns only is_public=true monitors
 *  3. /api/endpoints routes are gone (404)
 *  4. HTTP ownership scoping: /api/history and /api/status scoped by monitorId
 *  5. Socket.io room scoping unit tests
 */

require("dotenv").config();
const request  = require("supertest");
const jwt      = require("jsonwebtoken");
const pool     = require("../db/pool");
const { app }  = require("../index");
const { client: redisClient } = require("../redisClient");
const { storeMetric } = require("../redisClient");
const { notifyMonitorAdded, notifyMonitorRemoved } = require("../endpointRegistry");
const { getMonitorsForUser } = require("../poller");
const { userRoom }           = require("../socketHandler");

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "pw-access-dev-secret-change-in-prod";

function makeAuth(user) {
  const token = jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role, name: user.name },
    ACCESS_SECRET,
    { expiresIn: "15m" }
  );
  const csrf = `csrf-${user.id}-${Date.now()}`;
  return {
    attach: (req) => req.set("Cookie", `access_token=${token}; csrf_token=${csrf}`).set("x-csrf-token", csrf),
  };
}

let userA, userB, adminUser;
let authA, authB, authAdmin;
let publicMonitor, privateMonitor;

beforeAll(async () => {
  const rA = await pool.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ('scope_a_${Date.now()}', 'x', 'guest', 'Scope A') RETURNING id, username, role, name`
  );
  userA = rA.rows[0];

  const rB = await pool.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ('scope_b_${Date.now()}', 'x', 'guest', 'Scope B') RETURNING id, username, role, name`
  );
  userB = rB.rows[0];

  const rAdmin = await pool.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ('scope_admin_${Date.now()}', 'x', 'admin', 'Scope Admin') RETURNING id, username, role, name`
  );
  adminUser = rAdmin.rows[0];

  authA     = makeAuth(userA);
  authB     = makeAuth(userB);
  authAdmin = makeAuth(adminUser);

  const rPub = await pool.query(
    `INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
     VALUES ($1, 'Public Monitor', 'https://scoping-pub.example.com', 10, 200, true, true) RETURNING *`,
    [userA.id]
  );
  publicMonitor = rPub.rows[0];
  notifyMonitorAdded(publicMonitor);

  const rPriv = await pool.query(
    `INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
     VALUES ($1, 'Private Monitor', 'https://scoping-priv.example.com', 10, 200, true, false) RETURNING *`,
    [userA.id]
  );
  privateMonitor = rPriv.rows[0];
  notifyMonitorAdded(privateMonitor);

  // Seed fake metrics keyed by monitorId
  const fakeResult = (mid, url) => ({
    monitorId: mid, url, status: "up", httpStatus: 200, responseTime: 50,
    timestamp: new Date().toISOString(),
  });
  await storeMetric(publicMonitor.id,  fakeResult(publicMonitor.id,  publicMonitor.url));
  await storeMetric(privateMonitor.id, fakeResult(privateMonitor.id, privateMonitor.url));
});

afterAll(async () => {
  if (publicMonitor)  await pool.query("DELETE FROM monitors WHERE id = $1", [publicMonitor.id]);
  if (privateMonitor) await pool.query("DELETE FROM monitors WHERE id = $1", [privateMonitor.id]);
  if (userA)     await pool.query("DELETE FROM users WHERE id = $1", [userA.id]);
  if (userB)     await pool.query("DELETE FROM users WHERE id = $1", [userB.id]);
  if (adminUser) await pool.query("DELETE FROM users WHERE id = $1", [adminUser.id]);
  await redisClient.del(`metrics:${publicMonitor?.id}`, `metrics:${privateMonitor?.id}`);
  await pool.end().catch(() => {});
  await redisClient.quit().catch(() => {});
});

// ─── Gap 1: Poller driven by Postgres ────────────────────────────────────────

describe("Gap 1 — Poller driven by Postgres monitors table", () => {
  test("notifyMonitorAdded fires 'added' event with monitor object", () => {
    const { registry } = require("../endpointRegistry");
    const fired = [];
    registry.once("added", (m) => fired.push(m));
    const fake = { id: 99999, user_id: 1, url: "https://gap1-test.example.com", enabled: true, is_public: false, interval_seconds: 10, expected_status: 200 };
    notifyMonitorAdded(fake);
    expect(fired[0]).toMatchObject({ id: 99999 });
    notifyMonitorRemoved(fake);
  });

  test("notifyMonitorRemoved fires 'removed' event with monitor object", () => {
    const { registry } = require("../endpointRegistry");
    const fake = { id: 99998, user_id: 1, url: "https://gap1-remove.example.com", enabled: true, is_public: false, interval_seconds: 10, expected_status: 200 };
    notifyMonitorAdded(fake);
    const fired = [];
    registry.once("removed", (m) => fired.push(m));
    notifyMonitorRemoved(fake);
    expect(fired[0]).toMatchObject({ id: 99998 });
  });

  test("getMonitorsForUser returns only the requesting user's monitors", () => {
    const monitorsA = getMonitorsForUser(userA.id, false);
    const monitorsB = getMonitorsForUser(userB.id, false);
    const idsA = monitorsA.map((m) => m.id);
    expect(idsA).toContain(publicMonitor.id);
    expect(idsA).toContain(privateMonitor.id);
    expect(monitorsB.map((m) => m.id)).not.toContain(publicMonitor.id);
  });

  test("getMonitorsForUser with isAdmin=true returns all monitors", () => {
    const all = getMonitorsForUser(adminUser.id, true);
    const ids = all.map((m) => m.id);
    expect(ids).toContain(publicMonitor.id);
    expect(ids).toContain(privateMonitor.id);
  });
});

// ─── Gap 2: Public routes filter by is_public ─────────────────────────────────

describe("Gap 2 — GET /api/public/* only exposes is_public=true monitors", () => {
  test("GET /api/public/status does NOT include the private monitor", async () => {
    const res = await request(app).get("/api/public/status").expect(200);
    const ids = res.body.services.map((s) => s.monitorId);
    expect(ids).not.toContain(privateMonitor.id);
  });

  test("GET /api/public/status DOES include the public monitor", async () => {
    const res = await request(app).get("/api/public/status").expect(200);
    const ids = res.body.services.map((s) => s.monitorId);
    expect(ids).toContain(publicMonitor.id);
  });

  test("GET /api/public/incidents does NOT include incidents for the private monitor", async () => {
    // Seed a resolved incident directly in Postgres for the private (non-public) monitor.
    // The endpoint uses getPublicIncidents() which JOINs on is_public=true, so this
    // row must be excluded regardless of its presence in the DB.
    const { rows } = await pool.query(
      `INSERT INTO incidents (monitor_id, status, started_at, resolved_at, duration_ms)
       VALUES ($1, 'RESOLVED', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute', 60000)
       RETURNING id`,
      [privateMonitor.id]
    );
    const insertedId = rows[0].id;
    try {
      const res = await request(app).get("/api/public/incidents").expect(200);
      const mids = res.body.incidents.map((i) => i.monitorId);
      expect(mids).not.toContain(privateMonitor.id);
    } finally {
      await pool.query("DELETE FROM incidents WHERE id = $1", [insertedId]);
    }
  });

  test("GET /api/public/incidents DOES include incidents for the public monitor", async () => {
    // Seed a resolved incident directly in Postgres for the public monitor.
    // The endpoint uses getPublicIncidents() which JOINs on is_public=true, so this
    // row must appear in the response.
    const { rows } = await pool.query(
      `INSERT INTO incidents (monitor_id, status, started_at, resolved_at, duration_ms)
       VALUES ($1, 'RESOLVED', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute', 60000)
       RETURNING id`,
      [publicMonitor.id]
    );
    const insertedId = rows[0].id;
    try {
      const res = await request(app).get("/api/public/incidents").expect(200);
      const mids = res.body.incidents.map((i) => i.monitorId);
      expect(mids).toContain(publicMonitor.id);
    } finally {
      await pool.query("DELETE FROM incidents WHERE id = $1", [insertedId]);
    }
  });
});

// ─── Gap 3: /api/endpoints routes are gone ────────────────────────────────────

describe("Gap 3 — Legacy /api/endpoints routes are removed", () => {
  test("GET /api/endpoints returns 404",    async () => { await authA.attach(request(app).get("/api/endpoints")).expect(404); });
  test("POST /api/endpoints returns 404",   async () => { await authAdmin.attach(request(app).post("/api/endpoints")).send({ url: "https://x.com" }).expect(404); });
  test("DELETE /api/endpoints returns 404", async () => { await authAdmin.attach(request(app).delete("/api/endpoints")).send({ url: "https://x.com" }).expect(404); });
});

// ─── Gap 4: HTTP ownership scoping ───────────────────────────────────────────

describe("Gap 4 — HTTP endpoint ownership scoping", () => {
  describe("GET /api/history?monitorId=", () => {
    test("owner can fetch history for their own monitor", async () => {
      const res = await authA
        .attach(request(app).get(`/api/history?monitorId=${publicMonitor.id}`))
        .expect(200);
      expect(res.body.monitorId).toBe(publicMonitor.id);
      expect(Array.isArray(res.body.results)).toBe(true);
    });

    test("non-owner gets 403 for another user's monitor", async () => {
      await authB
        .attach(request(app).get(`/api/history?monitorId=${publicMonitor.id}`))
        .expect(403);
    });

    test("admin can fetch history for any monitor", async () => {
      const res = await authAdmin
        .attach(request(app).get(`/api/history?monitorId=${privateMonitor.id}`))
        .expect(200);
      expect(res.body.monitorId).toBe(privateMonitor.id);
    });

    test("missing monitorId returns 400", async () => {
      await authA.attach(request(app).get("/api/history")).expect(400);
    });
  });

  describe("GET /api/status", () => {
    test("returns only the requesting user's monitors", async () => {
      const res = await authA.attach(request(app).get("/api/status")).expect(200);
      const ids = Object.keys(res.body.monitors).map(Number);
      expect(ids).toContain(publicMonitor.id);
      expect(ids).toContain(privateMonitor.id);
    });

    test("userB's /api/status does not include userA's monitors", async () => {
      const res = await authB.attach(request(app).get("/api/status")).expect(200);
      const ids = Object.keys(res.body.monitors).map(Number);
      expect(ids).not.toContain(publicMonitor.id);
      expect(ids).not.toContain(privateMonitor.id);
    });

    test("admin /api/status includes all monitors", async () => {
      const res = await authAdmin.attach(request(app).get("/api/status")).expect(200);
      const ids = Object.keys(res.body.monitors).map(Number);
      expect(ids).toContain(publicMonitor.id);
      expect(ids).toContain(privateMonitor.id);
    });
  });
});

// ─── Gap 4 (Socket.io): room naming ──────────────────────────────────────────

describe("Gap 4 — Socket.io room scoping (unit)", () => {
  test("userRoom() produces the correct room name", () => {
    expect(userRoom("42")).toBe("user:42");
    expect(userRoom(7)).toBe("user:7");
  });

  test("broadcastMetric targets owner rooms via monitorId lookup", () => {
    const { getActiveMonitors } = require("../endpointRegistry");
    const monitors = getActiveMonitors();
    const ownersOfPublic = monitors
      .filter((m) => m.id === publicMonitor.id)
      .map((m) => String(m.user_id));
    expect(ownersOfPublic).toContain(String(userA.id));
    expect(ownersOfPublic).not.toContain(String(userB.id));
  });
});
