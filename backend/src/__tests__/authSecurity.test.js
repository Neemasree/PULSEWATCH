require("dotenv").config();

const pool = require("../db/pool");
const { client: redisClient } = require("../redisClient");
const {
  register,
  login,
  checkLockout,
  clearFailures,
} = require("../auth");

describe("authentication input and lockout privacy", () => {
  const suffix = Date.now().toString().slice(-8);
  const username = `PwCase${suffix}`;
  const password = "ValidPass123";
  const unknownUsername = `Missing${suffix}`;
  let userId;

  afterAll(async () => {
    if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await clearFailures(username).catch(() => {});
    await clearFailures(unknownUsername).catch(() => {});
    redisClient.disconnect();
    await pool.end().catch(() => {});
  });

  test("registers a valid guest account and supports case-insensitive login", async () => {
    const result = await register(username, password, "PulseWatch Test");
    userId = result.user.id;

    const signedIn = await login(username.toUpperCase(), password);
    expect(signedIn.user.id).toBe(String(userId));
    expect(signedIn.user.username).toBe(username);
    expect(signedIn.accessToken).toBeTruthy();
    expect(signedIn.refreshToken).toBeTruthy();
  });

  test("rejects case-only duplicate usernames", async () => {
    await expect(register(username.toLowerCase(), password, "Duplicate User"))
      .rejects.toThrow(/Unable to register with those details/);
  });

  test("rejects unsafe input types and bcrypt-truncated passwords", async () => {
    await expect(register({}, password, "Valid Name")).rejects.toThrow(/must be strings/i);
    await expect(register(`User${suffix}`, password, null)).rejects.toThrow(/must be strings/i);
    await expect(register(`Long${suffix}`, `A1${"x".repeat(72)}`, "Valid Name"))
      .rejects.toThrow(/72 UTF-8 bytes/);
    await expect(login({}, password)).rejects.toThrow(/Invalid credentials/);
    await expect(login(username, "x".repeat(73))).rejects.toThrow(/Invalid credentials/);
  });

  test("returns the same generic failure for wrong, locked and missing accounts", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(login(username, "WrongPass123")).rejects.toThrow("Invalid credentials");
    }
    expect(await checkLockout(username)).toMatch(/Account locked/i);
    await expect(login(username, password)).rejects.toThrow("Invalid credentials");
    await expect(login(unknownUsername, "WrongPass123")).rejects.toThrow("Invalid credentials");
  });

  test("successful login clears the failure counter and lockout", async () => {
    await clearFailures(username);
    const result = await login(username, password);
    expect(result.user.id).toBe(String(userId));
    expect(await checkLockout(username)).toBeNull();
  });
});
