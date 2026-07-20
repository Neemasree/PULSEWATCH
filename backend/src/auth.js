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
 */

const jwt    = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// Separate secrets per token type
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || "pw-access-dev-secret-change-in-prod";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "pw-refresh-dev-secret-change-in-prod";
const ACCESS_EXPIRY  = "15m";
const REFRESH_EXPIRY = "7d";

// ── Dummy hash — used when username not found so timing looks identical ──────
// Pre-computed: bcrypt.hashSync("__dummy__", 12)
const DUMMY_HASH = "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCi0KRSQ/4pJVuWzQN/mzYi";

// ── In-memory user store (swap for DB in production) ─────────────────────────
// Hashes are stored as literals (pre-computed offline with bcrypt cost 12).
// We do NOT call bcrypt.hashSync at module load — that blocks the Node.js
// event loop for ~2-3 seconds per hash, stalling every request on startup.
//
// To regenerate:
//   node -e "const b=require('bcryptjs'); console.log(b.hashSync('admin123',12));"
const USERS = [
  {
    id: "1",
    username: "admin",
    // bcrypt.hashSync("admin123", 12) — verified
    passwordHash: "$2a$12$1wTTPDn0x4ZL6I9JfNWY3uou.466dAZlY1rfpC3i3frzF9KNwCSJy",
    role: "admin",
    name: "Admin User",
  },
  {
    id: "2",
    username: "guest",
    // bcrypt.hashSync("guest123", 12) — verified
    passwordHash: "$2a$12$DHvBf50EddlvdOlNjKgZXuA0yewFZ3HX/2ocGvQGZe5/S8PSm.jQ6",
    role: "guest",
    name: "Guest User",
  },
];

// ── Refresh token blacklist ───────────────────────────────────────────────────
// Stores JTI (unique token ID) → expiry timestamp.
// On every refresh, the old JTI is added here; tokens in this set are rejected
// even if their signature is valid.
// In production: use a Redis SET with TTL so the set doesn't grow unbounded.
const refreshBlacklist = new Map(); // jti → expiry ms

function isBlacklisted(jti) {
  const exp = refreshBlacklist.get(jti);
  if (!exp) return false;
  if (Date.now() > exp) { refreshBlacklist.delete(jti); return false; } // expired entry
  return true;
}

function blacklist(jti, expMs) {
  refreshBlacklist.set(jti, expMs);
}

// ── Account lockout store ─────────────────────────────────────────────────────
// username → { failCount, lockedUntil }
const lockouts = new Map();

const MAX_FAILS    = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes

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
    entry.failCount   = 0; // reset so next window starts clean after lockout expires
  }
  lockouts.set(username, entry);
}

function clearFailures(username) {
  lockouts.delete(username);
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function makeJti() {
  // Simple unique ID — in production use crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, name: user.name },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

function signRefreshToken(user) {
  const jti = makeJti();
  const token = jwt.sign(
    { sub: user.id, jti },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
  return { token, jti };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates credentials and returns signed token pair.
 * Throws with a generic "Invalid credentials" message on any failure so
 * callers cannot distinguish "no such user" from "wrong password".
 *
 * @param {string} username
 * @param {string} password
 * @returns {{ accessToken, refreshToken, refreshJti, user }}
 */
function login(username, password) {
  // Lockout check first
  const lockMsg = checkLockout(username);
  if (lockMsg) throw new Error(lockMsg);

  const user = USERS.find((u) => u.username === username);

  // Always run bcrypt compare (even on dummy hash) to prevent timing oracle
  const hash  = user ? user.passwordHash : DUMMY_HASH;
  const valid = bcrypt.compareSync(password, hash);

  if (!user || !valid) {
    // Only record failure against real usernames to prevent enumeration via
    // lockout behaviour on non-existent accounts
    if (user) recordFailure(username);
    throw new Error("Invalid credentials"); // same message always
  }

  clearFailures(username);

  const accessToken          = signAccessToken(user);
  const { token: refreshToken, jti: refreshJti } = signRefreshToken(user);

  return {
    accessToken,
    refreshToken,
    refreshJti,
    user: { id: user.id, username: user.username, role: user.role, name: user.name },
  };
}

/**
 * Rotates a refresh token: verifies the old one, blacklists it, issues new pair.
 * Throws if the token is invalid, expired, or already blacklisted.
 *
 * @param {string} oldRefreshToken
 * @returns {{ accessToken, refreshToken, refreshJti }}
 */
function rotateRefreshToken(oldRefreshToken) {
  let payload;
  try {
    payload = jwt.verify(oldRefreshToken, REFRESH_SECRET);
  } catch {
    throw new Error("Invalid or expired refresh token");
  }

  if (isBlacklisted(payload.jti)) {
    // Token reuse detected — this is a replay attack or the user
    // logged out and is trying to reuse the old token.
    throw new Error("Refresh token already used");
  }

  // Blacklist the old token for the remainder of its natural lifetime
  blacklist(payload.jti, payload.exp * 1000);

  const user = USERS.find((u) => u.id === payload.sub);
  if (!user) throw new Error("User no longer exists");

  const accessToken = signAccessToken(user);
  const { token: refreshToken, jti: refreshJti } = signRefreshToken(user);

  return { accessToken, refreshToken, refreshJti, user: { id: user.id, username: user.username, role: user.role, name: user.name } };
}

/**
 * Invalidates a refresh token JTI so logout is server-enforced.
 * Without this, clearing the cookie still leaves a valid 7-day token
 * that a stolen cookie could replay.
 *
 * @param {string} refreshToken
 */
function revokeRefreshToken(refreshToken) {
  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);
    blacklist(payload.jti, payload.exp * 1000);
  } catch {
    // Token already expired or invalid — nothing to revoke, that's fine
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
 *
 * Flow:
 *   1. Server sets a plain (non-httpOnly) cookie "csrf_token" containing a
 *      random value when the client first authenticates.
 *   2. Client JS reads that cookie and sends it back as the
 *      "X-CSRF-Token" request header on every mutating request.
 *   3. Server verifies header === cookie value.
 *
 * Why does this work?
 *   A cross-origin page can trigger a form POST (CSRF attack) but it cannot
 *   READ the csrf_token cookie (same-origin policy) so it can't set the header.
 *   A same-origin page CAN read the cookie and set the header — so only
 *   legitimate requests from our own frontend pass.
 *
 * Note: SameSite=Strict on auth cookies already prevents most CSRF attacks;
 * this adds a second layer for defence-in-depth.
 */
function csrfProtect(req, res, next) {
  // Allow GET/HEAD/OPTIONS — they must be safe/idempotent by convention
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

/** Options for the httpOnly auth cookies */
const AUTH_COOKIE_OPTS = {
  httpOnly: true,                  // not readable by JS — blocks XSS token theft
  secure:   IS_PROD,               // HTTPS only in production; allow HTTP in dev
  sameSite: IS_PROD ? "strict" : "lax", // strict in prod; lax in dev (cross-port same-host)
  path:     "/",
};

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie("access_token",  accessToken,  { ...AUTH_COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie("refresh_token", refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });

  // CSRF token — deliberately NOT httpOnly so JS can read it
  const csrfToken = makeJti();
  res.cookie("csrf_token", csrfToken, {
    httpOnly: false,
    secure:   IS_PROD,
    sameSite: IS_PROD ? "strict" : "lax",
    path:     "/",
    maxAge:   15 * 60 * 1000, // matches access token lifetime
  });
}

function clearAuthCookies(res) {
  ["access_token", "refresh_token", "csrf_token"].forEach((name) => {
    res.clearCookie(name, { path: "/" });
  });
}

module.exports = {
  login, rotateRefreshToken, revokeRefreshToken,
  verifyAccessToken, requireAuth, requireRole, csrfProtect,
  setAuthCookies, clearAuthCookies,
  USERS,
};
