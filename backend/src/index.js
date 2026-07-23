/**
 * index.js
 * PulseWatch backend — Express + Socket.io entry point.
 *
 * Security layers applied (in order of the middleware stack):
 *   1. helmet          — sets 11 secure HTTP headers (CSP, HSTS, X-Frame-Options…)
 *   2. cors            — restricts which origins can make cross-origin requests
 *   3. cookie-parser   — parses httpOnly cookies for auth
 *   4. rate limiter    — 5 attempts / 15 min per IP on /api/auth/login
 *                        10 attempts / 15 min per IP on /api/auth/register
 *   5. requireAuth     — verifies access token from httpOnly cookie
 *   6. requireRole     — server-side RBAC check (not just UI hiding)
 *   7. csrfProtect     — double-submit cookie on all mutating routes
 *
 * Auth flow (cookie-based):
 *   POST /api/auth/login    → sets access_token (15m) + refresh_token (7d) cookies
 *   POST /api/auth/refresh  → rotates refresh token, issues new access token
 *   POST /api/auth/logout   → blacklists refresh token, clears all auth cookies
 *   GET  /api/auth/me       → returns user info decoded from access token cookie
 */

require("dotenv").config();

const express      = require("express");
const http         = require("http");
const { Server }   = require("socket.io");
const cors         = require("cors");
const helmet       = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit    = require("express-rate-limit");

const {
  login, register, rotateRefreshToken, revokeRefreshToken,
  requireAuth, requireRole, csrfProtect,
  setAuthCookies, clearAuthCookies,
} = require("./auth");

const { pingUrl }               = require("./pinger");
const { storeMetric, getRecentMetrics, getHourlyBuckets, getIncidents } = require("./redisClient");
const { startPolling, onResult, getPollingState, getOngoingOutages, getUrls } = require("./poller");
const { addUrl, removeUrl }     = require("./endpointRegistry");
const { initSocketHandler, broadcastMetric, broadcastPollingStats } = require("./socketHandler");

const PORT = process.env.PORT || 3000;
const rawOrigin = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const ALLOWED_ORIGINS = rawOrigin.split(",").map((s) => s.trim());
const IS_PROD = process.env.NODE_ENV === "production";

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// 1. Security headers
app.use(helmet({
  // Relax CSP in dev so Vite HMR works; tighten in production
  contentSecurityPolicy: IS_PROD,
  crossOriginEmbedderPolicy: false, // needed for socket.io
}));

// 2. CORS — credentials:true required for cross-origin cookie sending
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,  // REQUIRED for cookies to be sent cross-origin
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
}));

// 3. Body + cookie parsing
app.use(express.json());
app.use(cookieParser());

// ─── Rate limiter — IP-level brute force protection on login ──────────────────
// Guards against credential stuffing from one IP regardless of username.
// Separate from the per-account lockout in auth.js — both layers matter:
//   Rate limiter: stops volume attacks from one IP
//   Account lockout: stops distributed attacks targeting one account
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minute window
  max:              5,               // 5 attempts per IP per window
  standardHeaders:  true,           // returns RateLimit-* headers
  legacyHeaders:    false,
  message:          { error: "Too many login attempts. Try again in 15 minutes." },
  skipSuccessfulRequests: true,      // only count failures toward the limit
});

// Rate limiter for registration — prevents flooding the in-memory USERS array.
// Slightly more generous than login (10 attempts) since registration is a one-time
// action per user, but still limits abuse from a single IP.
const registerLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minute window
  max:              10,              // 10 attempts per IP per window
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: "Too many registration attempts. Try again in 15 minutes." },
  skipSuccessfulRequests: true,
});

// ─── HTTP + Socket.io ─────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true, methods: ["GET", "POST"] },
});
initSocketHandler(io);

// ─── Auth routes (public — no requireAuth) ────────────────────────────────────

/**
 * POST /api/auth/login
 * Validates credentials, sets httpOnly auth cookies, returns user info.
 * Rate-limited to 5 attempts / 15 min per IP.
 */
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  try {
    const { accessToken, refreshToken, user } = await login(username, password);
    setAuthCookies(res, accessToken, refreshToken);
    return res.json({ user });
  } catch (err) {
    const isLockout = err.message.startsWith("Account locked");
    return res.status(401).json({ error: isLockout ? err.message : "Invalid credentials" });
  }
});

/**
 * POST /api/auth/register
 * Creates a new guest account. Returns user info + sets auth cookies.
 * Body: { username, password, name }
 */
app.post("/api/auth/register", registerLimiter, async (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username || !password || !name) {
    return res.status(400).json({ error: "Username, password and name are required" });
  }
  try {
    const { accessToken, refreshToken, user } = await register(username, password, name);
    setAuthCookies(res, accessToken, refreshToken);
    return res.status(201).json({ user });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/auth/refresh
 * Reads the refresh_token cookie, rotates it, sets new cookies.
 * No CSRF check here — this route only reads a cookie, produces another cookie,
 * and returns no data that could be used in a CSRF attack.
 */
app.post("/api/auth/refresh", async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

  try {
    const { accessToken, refreshToken: newRefresh, user } = await rotateRefreshToken(refreshToken);
    setAuthCookies(res, accessToken, newRefresh);
    return res.json({ user });
  } catch (err) {
    clearAuthCookies(res);
    return res.status(401).json({ error: err.message });
  }
});

/**
 * POST /api/auth/logout
 * Blacklists the refresh token server-side and clears all auth cookies.
 * Without server-side blacklisting, clearing the cookie still leaves a valid
 * 7-day token that a stolen cookie could replay.
 */
app.post("/api/auth/logout", (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) revokeRefreshToken(refreshToken);
  clearAuthCookies(res);
  return res.json({ message: "Logged out" });
});

/**
 * GET /api/auth/me
 * Returns user info from the access token cookie.
 * Used by the frontend on mount to restore the session.
 */
app.get("/api/auth/me", requireAuth, (req, res) => {
  const { sub, username, role, name } = req.user;
  res.json({ id: sub, username, role, name });
});

// ─── Public routes (no auth) ──────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));
app.get("/health",     (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));
app.get("/api/debug/cors", (_req, res) => res.json({ allowedOrigins: ALLOWED_ORIGINS }));

/**
 * GET /api/public/status
 * Uptime % per URL for 24 h and 7 d — no auth required (public status page).
 */
app.get("/api/public/status", async (_req, res) => {
  try {
    const now = Date.now();
    const H24 = 24 * 60 * 60 * 1000;
    const D7  = 7 * H24;

    const services = await Promise.all(
      getUrls().map(async (url) => {
        const results   = await getRecentMetrics(url, 200);
        const hourlyBuckets = await getHourlyBuckets(url, 90);
        const latest    = results[0] || null;
        const b24       = results.filter((r) => now - new Date(r.timestamp).getTime() < H24);
        const b7        = results.filter((r) => now - new Date(r.timestamp).getTime() < D7);
        const upPct     = (bucket) => bucket.length
          ? parseFloat(((bucket.filter((r) => r.status === "up").length / bucket.length) * 100).toFixed(2))
          : null;
        const avgLat    = (bucket) => bucket.length
          ? Math.round(bucket.reduce((s, r) => s + (r.responseTime || 0), 0) / bucket.length)
          : null;
        return {
          url,
          currentStatus: latest?.status ?? "unknown",
          latency:       latest?.responseTime ?? null,
          uptime24h:     upPct(b24),
          uptime7d:      upPct(b7),
          avgLatency24h: avgLat(b24),
          lastChecked:   latest?.timestamp ?? null,
          hourlyBuckets, // array of 90 "up"|"down"|"unknown" entries, oldest→newest
        };
      })
    );
    res.json({ services, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/public/incidents
 * Returns the last 10 resolved incidents per URL, plus any currently ongoing
 * outages from in-memory poller state. No auth required (public status page).
 *
 * Response shape:
 *   { incidents: [ { url, startedAt, resolvedAt, durationMs } | { url, startedAt, ongoing: true } ] }
 *   Sorted newest-first by startedAt.
 */
app.get("/api/public/incidents", async (_req, res) => {
  try {
    const urls = getUrls();

    // Fetch resolved incidents from Redis for every monitored URL
    const resolved = (
      await Promise.all(urls.map((url) => getIncidents(url, 10)))
    ).flat();

    // Merge in any currently-ongoing outages from poller in-memory state
    const ongoing = getOngoingOutages();

    // Combine, sort newest-first
    const all = [...ongoing, ...resolved].sort((a, b) => b.startedAt - a.startedAt);

    res.json({ incidents: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Authenticated routes ─────────────────────────────────────────────────────

app.get("/api/check", requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: '"url" is required' });
  try {
    const result = await pingUrl(url);
    await storeMetric(url, result).catch(() => {});
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", requireAuth, async (req, res) => {
  const { url } = req.query;
  const n = Math.min(parseInt(req.query.n || "20", 10), 500);
  if (!url) return res.status(400).json({ error: '"url" is required' });
  try {
    return res.json({ url, results: await getRecentMetrics(url, n) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", requireAuth, async (req, res) => {
  try {
    const latest = {};
    await Promise.all(getUrls().map(async (url) => {
      const [r] = await getRecentMetrics(url, 1);
      latest[url] = r || null;
    }));
    return res.json({ urls: latest, polling: getPollingState() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/polling-stats", requireAuth, (_req, res) => res.json(getPollingState()));

app.get("/api/endpoints", requireAuth, (_req, res) => res.json({ urls: getUrls() }));

// Admin-only mutating routes: requireAuth + requireRole + csrfProtect
app.post("/api/endpoints", requireAuth, requireRole("admin"), csrfProtect, (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: '"url" is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }
  const added = addUrl(url);
  if (!added) return res.status(409).json({ error: "URL already monitored" });
  io.emit("endpoints-updated", { urls: getUrls() });
  return res.status(201).json({ message: "URL added", urls: getUrls() });
});

app.delete("/api/endpoints", requireAuth, requireRole("admin"), csrfProtect, (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: '"url" is required' });
  const removed = removeUrl(url);
  if (!removed) return res.status(404).json({ error: "URL not found" });
  io.emit("endpoints-updated", { urls: getUrls() });
  return res.json({ message: "URL removed", urls: getUrls() });
});

// ─── Poller → Socket.io bridge ────────────────────────────────────────────────
onResult((result, anomaly) => {
  broadcastMetric({ ...result, anomaly });
  broadcastPollingStats(getPollingState());
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[Server] PulseWatch on http://localhost:${PORT}`);
  console.log(`[Server] CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`[Server] Production mode: ${IS_PROD}`);
  startPolling();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const { client: redisClient } = require("./redisClient");
const pgPool = require("./db/pool");

async function shutdown(sig) {
  console.log(`[Server] ${sig} — shutting down`);
  await Promise.all([
    redisClient.quit().catch(() => {}),
    pgPool.end().catch(() => {}),
  ]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
