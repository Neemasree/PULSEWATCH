/**
 * incidents.test.js
 * Phase 4 — PostgreSQL incident lifecycle tests.
 *
 * Tests:
 *  1. openIncident creates a new OPEN row
 *  2. openIncident is idempotent — duplicate call returns existing row (no crash)
 *  3. resolveIncident sets RESOLVED + duration_ms
 *  4. getPublicIncidents returns at most 10 per monitor (ROW_NUMBER partition)
 *  5. getPublicIncidents excludes non-public monitors
 *  6. GET /api/incidents requires auth
 *  7. GET /api/incidents returns incidents for own monitor
 *  8. GET /api/incidents returns 403 for another user's monitor
 *  9. POST /api/incidents/:id/acknowledge sets ACKNOWLEDGED
 * 10. POST /api/incidents/:id/acknowledge returns 404 for another user's incident
 */

require("dotenv").config();
const request  = require("supertest");
const jwt      = require("jsonwebtoken");
const pool     = require("../db/pool");
const { app }  = require("../index");
const {
  openIncident,
  resolveIncident,
  acknowledgeIncident,
  getIncidentsByMonitor,
  getPublicIncidents,
} = require("../db/incidents");

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

// ─── Shared fixtures ──────────────────────────────────────────────────────────

let owner, other, authOwner, authOther;
let publicMonitor, privateMonitor, otherMonitor;

beforeAll(async () => {
  const ts = Date.now();

  // Two users
  const u1 = await pool.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ('inc_owner_${ts}', 'x', 'guest', 'Inc Owner') RETURNING id, username, role, name`
  );
  owner     = u1.rows[0];
  authOwner = makeAuth(owner);

  const u2 = await pool.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ('inc_other_${ts}', 'x', 'guest', 'Inc Other') RETURNING id, username, role, name`
  );
  other     = u2.rows[0];
  authOther = makeAuth(other);

  // Monitors
  const m1 = await pool.query(
    `INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
     VALUES ($1, 'Public Mon', 'https://inc-pub.example.com', 10, 200, true, true) RETURNING *`,
    [owner.id]
  );
  publicMonitor = m1.rows[0];

  const m2 = await pool.query(
    `INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
     VALUES ($1, 'Private Mon', 'https://inc-priv.example.com', 10, 200, true, false) RETURNING *`,
    [owner.id]
  );
  privateMonitor = m2.rows[0];

  const m3 = await pool.query(
    `INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
     VALUES ($1, 'Other Mon', 'https://inc-other.example.com', 10, 200, true, false) RETURNING *`,
    [other.id]
  );
  otherMonitor = m3.rows[0];
});

afterAll(async () => {
  // Cascade deletes incidents via ON DELETE CASCADE
  if (owner) await pool.query("DELETE FROM users WHERE id = $1", [owner.id]);
  if (other) await pool.query("DELETE FROM users WHERE id = $1", [other.id]);
  await pool.end().catch(() => {});
});

// ─── Unit: openIncident ───────────────────────────────────────────────────────

describe("openIncident", () => {
  let incident;

  afterEach(async () => {
    if (incident) {
      await pool.query("DELETE FROM incidents WHERE id = $1", [incident.id]);
      incident = null;
    }
  });

  test("creates a new OPEN incident row", async () => {
    incident = await openIncident({ monitorId: publicMonitor.id, startedAt: new Date() });
    expect(incident).toBeDefined();
    expect(incident.monitor_id).toBe(publicMonitor.id);
    expect(incident.status).toBe("OPEN");
    expect(incident.id).toBeGreaterThan(0);
  });

  test("duplicate call returns existing row without throwing (unique-constraint recovery)", async () => {
    incident = await openIncident({ monitorId: publicMonitor.id, startedAt: new Date() });
    const duplicate = await openIncident({ monitorId: publicMonitor.id, startedAt: new Date() });
    expect(duplicate).toBeDefined();
    expect(duplicate.id).toBe(incident.id); // same row returned
  });
});

// ─── Unit: resolveIncident ────────────────────────────────────────────────────

describe("resolveIncident", () => {
  test("sets status RESOLVED and computes duration_ms", async () => {
    const startedAt  = new Date(Date.now() - 30_000);
    const resolvedAt = new Date();
    const opened = await openIncident({ monitorId: privateMonitor.id, startedAt });
    const resolved = await resolveIncident({ incidentId: opened.id, resolvedAt });

    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolved_at).toBeTruthy();
    expect(resolved.duration_ms).toBeGreaterThan(0);

    await pool.query("DELETE FROM incidents WHERE id = $1", [opened.id]);
  });

  test("returns null for an already-resolved incident", async () => {
    const opened = await openIncident({ monitorId: privateMonitor.id, startedAt: new Date() });
    await resolveIncident({ incidentId: opened.id, resolvedAt: new Date() });
    const second = await resolveIncident({ incidentId: opened.id, resolvedAt: new Date() });
    expect(second).toBeNull();
    await pool.query("DELETE FROM incidents WHERE id = $1", [opened.id]);
  });
});

// ─── Unit: getPublicIncidents (ROW_NUMBER per monitor) ────────────────────────

describe("getPublicIncidents — per-monitor limit via ROW_NUMBER", () => {
  const insertedIds = [];

  beforeAll(async () => {
    // Insert 12 resolved incidents for the public monitor
    for (let i = 0; i < 12; i++) {
      const startedAt  = new Date(Date.now() - (i + 2) * 60_000);
      const resolvedAt = new Date(Date.now() - (i + 1) * 60_000);
      const { rows } = await pool.query(
        `INSERT INTO incidents (monitor_id, status, started_at, resolved_at, duration_ms)
         VALUES ($1, 'RESOLVED', $2, $3, 60000) RETURNING id`,
        [publicMonitor.id, startedAt, resolvedAt]
      );
      insertedIds.push(rows[0].id);
    }
    // Insert 1 resolved incident for the private monitor (should be excluded)
    const { rows } = await pool.query(
      `INSERT INTO incidents (monitor_id, status, started_at, resolved_at, duration_ms)
       VALUES ($1, 'RESOLVED', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes', 60000) RETURNING id`,
      [privateMonitor.id]
    );
    insertedIds.push(rows[0].id);
  });

  afterAll(async () => {
    if (insertedIds.length) {
      await pool.query(`DELETE FROM incidents WHERE id = ANY($1)`, [insertedIds]);
    }
  });

  test("returns at most 10 incidents for the public monitor", async () => {
    const rows = await getPublicIncidents();
    const forPublic = rows.filter((r) => r.monitor_id === publicMonitor.id);
    expect(forPublic.length).toBe(10);
  });

  test("excludes incidents for non-public monitors", async () => {
    const rows = await getPublicIncidents();
    const forPrivate = rows.filter((r) => r.monitor_id === privateMonitor.id);
    expect(forPrivate.length).toBe(0);
  });
});

// ─── HTTP: GET /api/incidents ─────────────────────────────────────────────────

describe("GET /api/incidents", () => {
  let incidentId;

  beforeAll(async () => {
    const row = await openIncident({ monitorId: publicMonitor.id, startedAt: new Date() });
    incidentId = row.id;
    // Register monitor in registry so ownership check passes
    const { notifyMonitorAdded } = require("../endpointRegistry");
    notifyMonitorAdded(publicMonitor);
    notifyMonitorAdded(otherMonitor);
  });

  afterAll(async () => {
    if (incidentId) await pool.query("DELETE FROM incidents WHERE id = $1", [incidentId]);
  });

  test("returns 401 without auth", async () => {
    await request(app).get(`/api/incidents?monitorId=${publicMonitor.id}`).expect(401);
  });

  test("returns incidents for own monitor", async () => {
    const res = await authOwner
      .attach(request(app).get(`/api/incidents?monitorId=${publicMonitor.id}`))
      .expect(200);
    expect(res.body.monitorId).toBe(publicMonitor.id);
    expect(Array.isArray(res.body.incidents)).toBe(true);
    expect(res.body.incidents.some((i) => i.id === incidentId)).toBe(true);
  });

  test("returns 403 for another user's monitor", async () => {
    await authOther
      .attach(request(app).get(`/api/incidents?monitorId=${publicMonitor.id}`))
      .expect(403);
  });
});

// ─── HTTP: POST /api/incidents/:id/acknowledge ────────────────────────────────

describe("POST /api/incidents/:id/acknowledge", () => {
  let incidentId;

  beforeAll(async () => {
    const row = await openIncident({ monitorId: publicMonitor.id, startedAt: new Date() });
    incidentId = row.id;
  });

  afterAll(async () => {
    if (incidentId) await pool.query("DELETE FROM incidents WHERE id = $1", [incidentId]);
  });

  test("owner can acknowledge their incident", async () => {
    const res = await authOwner
      .attach(request(app).post(`/api/incidents/${incidentId}/acknowledge`))
      .expect(200);
    expect(res.body.incident.status).toBe("ACKNOWLEDGED");
    expect(res.body.incident.acknowledged_at).toBeTruthy();
  });

  test("other user cannot acknowledge owner's incident (returns 404)", async () => {
    // Create a fresh OPEN incident for this test
    const row = await openIncident({ monitorId: otherMonitor.id, startedAt: new Date() });
    const res = await authOwner
      .attach(request(app).post(`/api/incidents/${row.id}/acknowledge`))
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
    await pool.query("DELETE FROM incidents WHERE id = $1", [row.id]);
  });
});

// ─── HTTP: GET /api/public/incidents ─────────────────────────────────────────

describe("GET /api/public/incidents", () => {
  let insertedId;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `INSERT INTO incidents (monitor_id, status, started_at, resolved_at, duration_ms)
       VALUES ($1, 'RESOLVED', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes', 300000)
       RETURNING id`,
      [publicMonitor.id]
    );
    insertedId = rows[0].id;
  });

  afterAll(async () => {
    if (insertedId) await pool.query("DELETE FROM incidents WHERE id = $1", [insertedId]);
  });

  test("returns 200 with incidents array (no auth required)", async () => {
    const res = await request(app).get("/api/public/incidents").expect(200);
    expect(Array.isArray(res.body.incidents)).toBe(true);
  });

  test("resolved incident for public monitor appears in response", async () => {
    const res = await request(app).get("/api/public/incidents").expect(200);
    const found = res.body.incidents.find((i) => i.monitorId === publicMonitor.id && i.resolvedAt);
    expect(found).toBeDefined();
    expect(found.durationMs).toBeGreaterThan(0);
  });
});
