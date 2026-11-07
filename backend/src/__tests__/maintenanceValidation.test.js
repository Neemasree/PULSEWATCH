require("dotenv").config();

const request = require("supertest");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { client: redisClient } = require("../redisClient");
const { app } = require("../index");
const { ACCESS_SECRET } = require("../auth");

describe("maintenance request validation", () => {
  let userId;
  let monitorId;
  let cookieHeader;
  let csrfToken;

  beforeAll(async () => {
    const suffix = Date.now();
    const user = await pool.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ($1, 'test-hash', 'guest', 'Maintenance Test')
       RETURNING id, username, role, name`,
      [`maintenance_test_${suffix}`]
    );
    const row = user.rows[0];
    userId = row.id;
    const token = jwt.sign(
      { sub: String(row.id), username: row.username, role: row.role, name: row.name },
      ACCESS_SECRET,
      { expiresIn: "15m" }
    );
    csrfToken = `csrf-${suffix}`;
    cookieHeader = `access_token=${token}; csrf_token=${csrfToken}`;

    const monitor = await pool.query(
      `INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled)
       VALUES ($1, 'Maintenance test monitor', 'https://example.com', 60, 200, false)
       RETURNING id`,
      [userId]
    );
    monitorId = monitor.rows[0].id;
  });

  afterAll(async () => {
    if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    redisClient.disconnect();
    await pool.end().catch(() => {});
  });

  function postMaintenance(body) {
    return request(app)
      .post(`/api/monitors/${monitorId}/maintenance`)
      .set("Cookie", cookieHeader)
      .set("x-csrf-token", csrfToken)
      .send(body);
  }

  test.each([
    ["non-string start date", { starts_at: 123, ends_at: "2026-11-08T12:00:00.000Z" }],
    ["non-string end date", { starts_at: "2026-11-08T11:00:00.000Z", ends_at: [] }],
    ["invalid start date", { starts_at: "not-a-date", ends_at: "2026-11-08T12:00:00.000Z" }],
    ["end before start", { starts_at: "2026-11-08T12:00:00.000Z", ends_at: "2026-11-08T11:00:00.000Z" }],
    ["overlong duration", { starts_at: "2026-11-08T12:00:00.000Z", ends_at: "2028-11-08T12:00:00.000Z" }],
    ["non-string reason", { starts_at: "2026-11-08T11:00:00.000Z", ends_at: "2026-11-08T12:00:00.000Z", reason: {} }],
    ["overlong reason", { starts_at: "2026-11-08T11:00:00.000Z", ends_at: "2026-11-08T12:00:00.000Z", reason: "x".repeat(301) }],
  ])("rejects %s", async (_label, body) => {
    await postMaintenance(body).expect(400);
  });

  test("trims a valid reason and creates a bounded maintenance window", async () => {
    const response = await postMaintenance({
      starts_at: "2026-11-08T11:00:00.000Z",
      ends_at: "2026-11-08T12:00:00.000Z",
      reason: "  planned maintenance  ",
    }).expect(201);

    expect(response.body.window.reason).toBe("planned maintenance");
    await request(app)
      .delete(`/api/maintenance/${response.body.window.id}`)
      .set("Cookie", cookieHeader)
      .set("x-csrf-token", csrfToken)
      .expect(200);
  });
});
