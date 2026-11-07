/**
 * auth.js
 * Interview-grade authentication + RBAC.
 *
 * ── Token architecture ────────────────────────────────────────────────────
 * Access token  (15 min)  — short-lived, sent in httpOnly cookie "access_token"
 * Refresh token (7 days)  — long-lived, sent in httpOnly cookie "refresh_token"
 *
 * Why two tokens instead of one long-lived one?
 *   If an access token leaks (logs, timing side-channels, etc.) it expires in
 *   15 minutes. The refresh token never touches JS memory — it lives only in
 *   an httpOnly cookie — so XSS can't steal it.
 *
 * Why rotate refresh tokens on every use?
 *   If a refresh token is somehow stolen and the thief uses it first, the next
 *   time the real user refreshes their token will fail (old token is blacklisted).
 *   The damage window is bounded to "time between legitimate refreshes", not
 *   the full 7-day lifetime.
 *
 * Why separate secrets for access vs refresh?
 *   A compromised access token secret doesn't let an attacker forge refresh
 *   tokens (and vice versa). Defence-in-depth on the signing keys.
 *
 * ── Password hashing ─────────────────────────────────────────────────────
 * bcrypt with cost factor 12. Factor 10 does ~10 hashes/s on modern hardware;
 * factor 12 does ~2-3 hashes/s — still fine for login, but much harder to
 * brute-force a leaked password DB at scale.
 *
 * ── Account lockout ──────────────────────────────────────────────────────
 * After 5 consecutive failures, the account is locked for 15 minutes.
 * Counter resets on successful login.
 * Separate from the IP-level rate limiter in index.js — both layers matter.
 *
 * ── Enumeration protection ───────────────────────────────────────────────
 * Both "user not found" and "wrong password" return the same generic message
 * and take the same code path (bcrypt compare still runs on a dummy hash so
 * timing is consistent — no timing oracle on username existence).
 *
 * ── User storage ─────────────────────────────────────────────────────────
 * Users are persisted in PostgreSQL (see migrations/000_users.sql).
 * The bcrypt, JWT, RBAC, and CSRF logic here is storage-agnostic — only
 * the three DB helper functions (findByUsername, createUser, findById) touch
 * the database. Swapping to a different DB only requires changing those three.
 */

const jwt    = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto      = require("crypto"); // built-in Node module — no install needed
const pool        = require("./db/pool");
const { client: redisClient } = require("./redisClient");

// Separate secrets per token type. Production must provide strong, stable keys;
// development/test gets per-process keys so missing configuration is never
// silently converted into a shared credential.
const IS_PROD = process.env.NODE_ENV === "production";
function loadSecret(name) {
  const configured = process.env[name];
  if (configured) {
    if (IS_PROD && configured.length < 32) {
      throw new Error(`${name} must be at least 32 characters in production`);
    }
    return configured;
  }
  if (IS_PROD) {
    throw new Error(`${name} is required in production`);
  }
  const generated = crypto.randomBytes(48).toString("hex");
  console.warn(`[Auth] ${name} is not set; generated a random development secret.`);
  return generated;
}

const ACCESS_SECRET  = loadSecret("JWT_ACCESS_SECRET");
const REFRESH_SECRET = loadSecret("JWT_REFRESH_SECRET");
const ACCESS_EXPIRY  = "15m";
const REFRESH_EXPIRY = "7d";

// ── Dummy hash — used when username not found so timing looks identical ──────
// Pre-computed: bcrypt.hashSync("__dummy__", 12)
const DUMMY_HASH = "$2a$12$07m3EJsWY2T7cAG6iESgiu/CqthjPb/SuxWbB0NLUu.QcEtAZZCme";

// ── PostgreSQL user helpers ───────────────────────────────────────────────────
// These are the ONLY three places that touch the database.
// All other auth logic above and below them is storage-agnostic.

/**
 * Looks up a user by username (case-insensitive).
 * Returns the row as { id, username, password_hash, role, name } or null.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
async function findByUsername(username) {
  const { rows } = await pool.query(
    "SELECT id, username, password_hash, role, name FROM users WHERE lower(username) = lower($1)",
    [username]
  );
  return rows[0] ?? null;
}

/**
 * Looks up a user by their numeric id (stored as the JWT sub claim).
 * Returns { id, username, role, name } or null.
 * @param {string|number} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  const { rows } = await pool.query(
    "SELECT id, username, role, name FROM users WHERE id = $1",
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Inserts a new user and returns the created row.
 * Username uniqueness is enforced by the UNIQUE constraint — the caller
 * catches the constraint error and converts it to a generic message.
 * @param {string} username
 * @param {string} passwordHash  bcrypt hash, never plaintext
 * @param {string} role          "guest" for all self-registered users
 * @param {string} name          Display name
 * @returns {Promise<{ id, username, role, name }>}
 */
async function createUser(username, passwordHash, role, name) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, role, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, role, name`,
    [username, passwordHash, role, name]
  );
  return rows[0];
}

/**
 * Creates the first admin only when explicitly configured at startup.
 * The advisory lock prevents duplicate bootstrap admins if two processes
 * start against the same empty database.
 */
async function bootstrapAdmin(customPool = pool) {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD must be provided together");
  }
  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  }

  const client = await customPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [918273]);
    const existing = await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return null;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await client.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ($1, $2, 'admin', $3)
       RETURNING id, username, role, name`,
      [username, passwordHash, username]
    );
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Refresh token blacklist (Redis-backed) ──────────────────────────────────
// Key: auth:blacklist:<jti> with TTL = token's remaining lifetime.
// Preserves blacklist state across server restarts and multiple backend replicas.

async function blacklist(jti, expMs) {
  const ttlSeconds = Math.max(1, Math.ceil((expMs - Date.now()) / 1000));
  await redisClient.set(`auth:blacklist:${jti}`, "1", "EX", ttlSeconds);
}

async function isBlacklisted(jti) {
  const exists = await redisClient.exists(`auth:blacklist:${jti}`);
  return exists === 1;
}

/**
 * Atomically consumes a refresh-token JTI exactly once.
 * Redis SET NX is the serialization point: concurrent refresh requests
 * cannot both observe an unused token and rotate it successfully.
 */
async function consumeRefreshToken(jti, expMs) {
  if (typeof jti !== "string" || !jti) {
    throw new Error("Invalid or expired refresh token");
  }
  const ttlSeconds = Math.max(1, Math.ceil((expMs - Date.now()) / 1000));
  const result = await redisClient.set(
    `auth:blacklist:${jti}`,
    "1",
    "EX",
    ttlSeconds,
    "NX"
  );
  if (result !== "OK") {
    throw new Error("Refresh token already used");
  }
}

// ── Account lockout store (Redis-backed) ─────────────────────────────────────
// Keys:
//   auth:fails:<username>   - counter of consecutive failures (15 min TTL)
//   auth:lockout:<username> - present only while locked out (15 min TTL)

const MAX_FAILS       = 5;
const LOCKOUT_SECONDS = 15 * 60; // 15 minutes

async function checkLockout(username) {
  const lockKey = `auth:lockout:${username.toLowerCase()}`;
  const ttl = await redisClient.ttl(lockKey);
  if (ttl > 0) {
    return `Account locked. Try again in ${ttl}s.`;
  }
  return null;
}

async function recordFailure(username) {
  const failsKey = `auth:fails:${username.toLowerCase()}`;
  const count = await redisClient.incr(failsKey);
  if (count === 1) {
    await redisClient.expire(failsKey, LOCKOUT_SECONDS);
  }
  if (count >= MAX_FAILS) {
    await redisClient.set(`auth:lockout:${username.toLowerCase()}`, "1", "EX", LOCKOUT_SECONDS);
    await redisClient.del(failsKey);
  }
}

async function clearFailures(username) {
  await redisClient.del(
    `auth:fails:${username.toLowerCase()}`,
    `auth:lockout:${username.toLowerCase()}`
  );
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function makeJti() {
  return crypto.randomUUID();
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role, name: user.name },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

function signRefreshToken(user) {
  const jti   = makeJti();
  const token = jwt.sign(
    { sub: String(user.id), jti },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
  return { token, jti };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates credentials and returns signed token pair.
 * Now async because findByUsername() queries Postgres.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ accessToken, refreshToken, refreshJti, user }>}
 */
async function login(username, password) {
  const cleanUsername = typeof username === "string" ? username.trim() : "";
  const validUsername = /^[a-zA-Z0-9_]{3,20}$/.test(cleanUsername);
  const validPassword = typeof password === "string" &&
    Buffer.byteLength(password, "utf8") > 0 &&
    Buffer.byteLength(password, "utf8") <= 72;

  // Do not reveal whether an account is locked. The same bcrypt work and
  // generic response are used for locked, missing and invalid credentials.
  const lockMsg = validUsername ? await checkLockout(cleanUsername) : null;
  if (lockMsg) {
    await bcrypt.compare("__invalid_login__", DUMMY_HASH);
    throw new Error("Invalid credentials");
  }

  const user = validUsername ? await findByUsername(cleanUsername) : null;
  const hash = user && validPassword ? user.password_hash : DUMMY_HASH;
  const candidate = validPassword ? password : "__invalid_login__";
  const valid = await bcrypt.compare(candidate, hash);

  if (!user || !valid || !validPassword) {
    if (user) await recordFailure(cleanUsername);
    throw new Error("Invalid credentials");
  }

  await clearFailures(cleanUsername);

  const accessToken = signAccessToken(user);
  const { token: refreshToken, jti: refreshJti } = signRefreshToken(user);

  return {
    accessToken,
    refreshToken,
    refreshJti,
    user: { id: String(user.id), username: user.username, role: user.role, name: user.name },
  };
}

/**
 * Registers a new guest account, persisting to Postgres.
 *
 * @param {string} username
 * @param {string} password
 * @param {string} name
 * @returns {Promise<{ accessToken, refreshToken, refreshJti, user }>}
 */
async function register(username, password, name) {
  if (typeof username !== "string" || typeof password !== "string" || typeof name !== "string") {
    throw new Error("Username, password and name must be strings");
  }

  const cleanUsername = username.trim();
  const cleanName = name.trim();
  if (!cleanUsername || !password || !cleanName) {
    throw new Error("Username, password and name are required");
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(cleanUsername)) {
    throw new Error("Username must be 3–20 characters (letters, numbers, underscore only)");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Password must be at most 72 UTF-8 bytes");
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must contain at least one letter and one number");
  }
  if (cleanName.length < 2 || cleanName.length > 40) {
    throw new Error("Name must be 2–40 characters");
  }
  if (cleanUsername.toLowerCase() === "admin") {
    throw new Error("Unable to register with those details");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let newUser;
  try {
    newUser = await createUser(cleanUsername, passwordHash, "guest", cleanName);
  } catch (err) {
    // Postgres unique constraint violation code = 23505
    if (err.code === "23505") {
      throw new Error("Unable to register with those details");
    }
    throw err; // unexpected DB error — let it bubble
  }

  const accessToken                              = signAccessToken(newUser);
  const { token: refreshToken, jti: refreshJti } = signRefreshToken(newUser);

  return {
    accessToken,
    refreshToken,
    refreshJti,
    user: { id: String(newUser.id), username: newUser.username, role: newUser.role, name: newUser.name },
  };
}

/**
 * Rotates a refresh token — now async because findById() queries Postgres.
 *
 * @param {string} oldRefreshToken
 * @returns {Promise<{ accessToken, refreshToken, refreshJti, user }>}
 */
async function rotateRefreshToken(oldRefreshToken) {
  let payload;
  try {
    payload = jwt.verify(oldRefreshToken, REFRESH_SECRET);
  } catch {
    throw new Error("Invalid or expired refresh token");
  }

  const user = await findById(payload.sub);
  if (!user) throw new Error("User no longer exists");

  // Consume before issuing replacement credentials. This operation is atomic
  // in Redis, so only one concurrent request can rotate a given token. Lookup
  // first so a transient PostgreSQL outage does not burn a valid refresh token.
  await consumeRefreshToken(payload.jti, payload.exp * 1000);

  const accessToken                              = signAccessToken(user);
  const { token: refreshToken, jti: refreshJti } = signRefreshToken(user);

  return {
    accessToken,
    refreshToken,
    refreshJti,
    user: { id: String(user.id), username: user.username, role: user.role, name: user.name },
  };
}

/**
 * Invalidates a refresh token JTI so logout is server-enforced.
 * @param {string} refreshToken
 */
async function revokeRefreshToken(refreshToken) {
  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);
    await blacklist(payload.jti, payload.exp * 1000);
  } catch {
    // Already expired or invalid — nothing to revoke
  }
}

/**
 * Verifies an access token and returns its payload.
 * @param {string} token
 * @returns {{ sub, username, role, name, iat, exp }}
 */
function verifyAccessToken(token) {
  if (!token) throw new Error("No token");
  return jwt.verify(token, ACCESS_SECRET);
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * requireAuth
 * Reads the access token from the httpOnly cookie "access_token".
 * Falls back to Authorization: Bearer header for API clients (curl, Postman).
 * Synchronous — verifyAccessToken only does JWT signature check, no DB hit.
 */
function requireAuth(req, res, next) {
  try {
    const cookieToken = req.cookies?.access_token;
    const header      = req.headers.authorization || "";
    const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token       = cookieToken || bearerToken;

    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

/**
 * requireRole(role)
 * Server-side RBAC check — must follow requireAuth.
 * Guests calling admin-only routes get 403 regardless of what the UI shows.
 */
function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: "Forbidden — insufficient role" });
    }
    next();
  };
}

/**
 * csrfProtect
 * Double-submit cookie CSRF protection for state-changing routes.
 */
function csrfProtect(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers["x-csrf-token"];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: "CSRF validation failed" });
  }
  next();
}

// ── Cookie config helpers ─────────────────────────────────────────────────────

const AUTH_COOKIE_OPTS = {
  httpOnly: true,
  secure:   IS_PROD,
  sameSite: IS_PROD ? "none" : "lax",
  path:     "/",
};

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie("access_token",  accessToken,  { ...AUTH_COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie("refresh_token", refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });

  const csrfToken = makeJti();
  res.cookie("csrf_token", csrfToken, {
    httpOnly: false,
    secure:   IS_PROD,
    sameSite: IS_PROD ? "none" : "lax",
    path:     "/",
    maxAge:   15 * 60 * 1000,
  });
}

function clearAuthCookies(res) {
  ["access_token", "refresh_token", "csrf_token"].forEach((name) => {
    res.clearCookie(name, { path: "/" });
  });
}

module.exports = {
  login, register, rotateRefreshToken, revokeRefreshToken,
  bootstrapAdmin,
  verifyAccessToken, requireAuth, requireRole, csrfProtect,
  setAuthCookies, clearAuthCookies,
  blacklist, isBlacklisted, consumeRefreshToken, checkLockout, recordFailure, clearFailures,
  ACCESS_SECRET,
};
