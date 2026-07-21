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
 * Users are persisted in PostgreSQL (see src/db/migrate.sql).
 * The bcrypt, JWT, RBAC, and CSRF logic here is storage-agnostic — only
 * the three DB helper functions (findByUsername, createUser, findById) touch
 * the database. Swapping to a different DB only requires changing those three.
 */

const jwt    = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto"); // built-in Node module — no install needed
const pool   = require("./db/pool");

// Separate secrets per token type
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || "pw-access-dev-secret-change-in-prod";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "pw-refresh-dev-secret-change-in-prod";
const ACCESS_EXPIRY  = "15m";
const REFRESH_EXPIRY = "7d";

// ── Dummy hash — used when username not found so timing looks identical ──────
// Pre-computed: bcrypt.hashSync("__dummy__", 12)
const DUMMY_HASH = "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCi0KRSQ/4pJVuWzQN/mzYi";

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

// ── Refresh token blacklist ───────────────────────────────────────────────────
// Stores JTI (unique token ID) → expiry timestamp.
// On every refresh, the old JTI is added here; tokens in this set are rejected
// even if their signature is valid.
// In production: use a Redis SET with TTL so the set doesn't grow unbounded
// across multiple server instances.
const refreshBlacklist = new Map(); // jti → expiry ms

function isBlacklisted(jti) {
  const exp = refreshBlacklist.get(jti);
  if (!exp) return false;
  if (Date.now() > exp) { refreshBlacklist.delete(jti); return false; }
  return true;
}

function blacklist(jti, expMs) {
  refreshBlacklist.set(jti, expMs);
}

// ── Account lockout store ─────────────────────────────────────────────────────
// username → { failCount, lockedUntil }
const lockouts = new Map();

const MAX_FAILS  = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkLockout(username) {
  const entry = lockouts.get(username);
  if (!entry) return null;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const remainSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return `Account locked. Try again in ${remainSec}s.`;
  }
  return null;
}

function recordFailure(username) {
  const entry = lockouts.get(username) || { failCount: 0, lockedUntil: null };
  entry.failCount++;
  if (entry.failCount >= MAX_FAILS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.failCount   = 0;
  }
  lockouts.set(username, entry);
}

function clearFailures(username) {
  lockouts.delete(username);
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
  // Lockout check — synchronous, no DB hit needed
  const lockMsg = checkLockout(username);
  if (lockMsg) throw new Error(lockMsg);

  const user = await findByUsername(username);

  // Always run bcrypt compare (even on dummy hash) to prevent timing oracle
  const hash  = user ? user.password_hash : DUMMY_HASH;
  const valid = await bcrypt.compare(password, hash);

  if (!user || !valid) {
    if (user) recordFailure(username);
    throw new Error("Invalid credentials");
  }

  clearFailures(username);

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
 * Registers a new guest account, persisting to Postgres.
 *
 * @param {string} username
 * @param {string} password
 * @param {string} name
 * @returns {Promise<{ accessToken, refreshToken, refreshJti, user }>}
 */
async function register(username, password, name) {
  if (!username || !password || !name) {
    throw new Error("Username, password and name are required");
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error("Username must be 3–20 characters (letters, numbers, underscore only)");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must contain at least one letter and one number");
  }
  if (name.trim().length < 2 || name.trim().length > 40) {
    throw new Error("Name must be 2–40 characters");
  }
  if (username.toLowerCase() === "admin") {
    throw new Error("Unable to register with those details");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let newUser;
  try {
    newUser = await createUser(username, passwordHash, "guest", name.trim());
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

  if (isBlacklisted(payload.jti)) {
    throw new Error("Refresh token already used");
  }

  blacklist(payload.jti, payload.exp * 1000);

  const user = await findById(payload.sub);
  if (!user) throw new Error("User no longer exists");

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
function revokeRefreshToken(refreshToken) {
  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);
    blacklist(payload.jti, payload.exp * 1000);
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

const IS_PROD = process.env.NODE_ENV === "production";

const AUTH_COOKIE_OPTS = {
  httpOnly: true,
  secure:   IS_PROD,
  sameSite: IS_PROD ? "strict" : "lax",
  path:     "/",
};

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie("access_token",  accessToken,  { ...AUTH_COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie("refresh_token", refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });

  const csrfToken = makeJti();
  res.cookie("csrf_token", csrfToken, {
    httpOnly: false,
    secure:   IS_PROD,
    sameSite: IS_PROD ? "strict" : "lax",
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
  verifyAccessToken, requireAuth, requireRole, csrfProtect,
  setAuthCookies, clearAuthCookies,
};
