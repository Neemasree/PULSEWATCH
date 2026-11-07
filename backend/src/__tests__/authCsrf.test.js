require("dotenv").config();

const request = require("supertest");
const { app } = require("../index");
const { client: redisClient } = require("../redisClient");
const pool = require("../db/pool");

describe("CSRF protection for session rotation and logout", () => {
  afterAll(async () => {
    redisClient.disconnect();
    await pool.end().catch(() => {});
  });

  test("rejects refresh and logout requests without a matching CSRF cookie/header", async () => {
    await request(app).post("/api/auth/refresh").expect(403);
    await request(app).post("/api/auth/logout").expect(403);
    await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "csrf_token=csrf-test")
      .set("x-csrf-token", "different-token")
      .expect(403);
  });

  test("allows CSRF-verified session endpoints to run their auth checks", async () => {
    const response = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "csrf_token=csrf-test")
      .set("x-csrf-token", "csrf-test")
      .expect(401);
    expect(response.body.error).toMatch(/refresh token/i);

    await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "csrf_token=csrf-test")
      .set("x-csrf-token", "csrf-test")
      .expect(200);
  });
});
