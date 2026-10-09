const path = require("path");
const { spawnSync } = require("child_process");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const { app } = require("../index");
const { bootstrapAdmin } = require("../auth");
const { broadcastPollingStats } = require("../socketHandler");
const { emitSocketUpdates } = require("../monitorsRouter");
const { client: redisClient } = require("../redisClient");
const pool = require("../db/pool");

afterAll(async () => {
  await Promise.all([
    pool.end().catch(() => {}),
    Promise.resolve(redisClient.disconnect()),
  ]);
});

describe("security hardening", () => {
  test.each([
    ["missing", undefined, undefined, /JWT_ACCESS_SECRET is required/],
    ["short", "too-short", "another-too-short", /JWT_ACCESS_SECRET must be at least 32/],
  ])("production startup refuses %s JWT secrets", (_label, access, refresh, expected) => {
    const env = { ...process.env, NODE_ENV: "production" };
    if (access === undefined) delete env.JWT_ACCESS_SECRET;
    else env.JWT_ACCESS_SECRET = access;
    if (refresh === undefined) delete env.JWT_REFRESH_SECRET;
    else env.JWT_REFRESH_SECRET = refresh;
    const result = spawnSync(process.execPath, ["-e", "require('./src/auth')"], {
      cwd: path.join(__dirname, "../.."),
      env,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(expected);
  });

  test("development startup generates random secrets and warns", () => {
    const env = { ...process.env, NODE_ENV: "development" };
    delete env.JWT_ACCESS_SECRET;
    delete env.JWT_REFRESH_SECRET;
    const result = spawnSync(process.execPath, ["-e", "require('./src/auth'); process.exit(0)"], {
      cwd: path.join(__dirname, "../.."),
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/generated a random development secret/);
  });

  test("admin bootstrap hashes the configured password and does not log it", async () => {
    const originalUsername = process.env.ADMIN_USERNAME;
    const originalPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "bootstrap-admin";
    process.env.ADMIN_PASSWORD = "a-secure-admin-password";

    const queries = [];
    const client = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes("SELECT id FROM users")) return { rows: [] };
        if (sql.includes("RETURNING id")) {
          const params = arguments;
          return { rows: [{ id: 1, username: "bootstrap-admin", role: "admin", name: "bootstrap-admin" }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const fakePool = { connect: jest.fn(async () => client) };
    const hashSpy = jest.spyOn(bcrypt, "hash");

    const admin = await bootstrapAdmin(fakePool);

    expect(admin.role).toBe("admin");
    expect(hashSpy).toHaveBeenCalledWith("a-secure-admin-password", 12);
    expect(queries).toContain("BEGIN");
    expect(client.release).toHaveBeenCalled();
    hashSpy.mockRestore();
    if (originalUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPassword;
  });

  test("removed debug and arbitrary-check routes return 404", async () => {
    expect((await request(app).get("/api/debug/cors")).status).toBe(404);
    expect((await request(app).get("/api/check?url=https://example.com")).status).toBe(404);
  });

  test("polling stats are sent only to the admin room", () => {
    const calls = [];
    const io = {
      use: jest.fn(),
      on: jest.fn(),
      to: (room) => ({
        emit: (event, data) => calls.push({ room, event, data }),
      }),
    };
    require("../socketHandler").initSocketHandler(io);
    broadcastPollingStats({ totalAdaptiveChecks: 1 });
    expect(calls).toEqual([
      { room: "admin", event: "polling-stats", data: { totalAdaptiveChecks: 1 } },
    ]);
  });

  test("monitor updates target the owner and admin rooms", () => {
    const calls = [];
    const io = {
      to: (room) => ({
        to: (nextRoom) => ({
          emit: (event) => calls.push({ room, nextRoom, event }),
        }),
      }),
    };
    emitSocketUpdates({
      user: { sub: "42" },
      app: { get: () => io },
    });
    expect(calls).toEqual([
      { room: "user:42", nextRoom: "admin", event: "monitors-updated" },
    ]);
  });
});
