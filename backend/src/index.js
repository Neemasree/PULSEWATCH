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
const swaggerUi    = require("swagger-ui-express");
const fs            = require("fs");
const path          = require("path");

const {
  login, register, rotateRefreshToken, revokeRefreshToken,
  bootstrapAdmin,
  requireAuth, requireRole, csrfProtect,
  setAuthCookies, clearAuthCookies,
} = require("./auth");

const { getRecentMetrics, getHourlyBuckets } = require("./redisClient");
const { startPolling, onResult, getPollingState, getOngoingOutages, getMonitorsForUser } = require("./poller");
const { loadFromDb, getPublicMonitors } = require("./endpointRegistry");
const { runMigrations }         = require("../scripts/migrate");
const monitorsRouter            = require("./monitorsRouter");
const alertChannelsRouter       = require("./alertChannelsRouter");
const { initSocketHandler, broadcastMetric, broadcastPollingStats, broadcastIncidentUpdate } = require("./socketHandler");
const { getPublicIncidents, getIncidentsByMonitor, acknowledgeIncident } = require("./db/incidents");
const { getMaintenanceWindows, createMaintenance, deleteMaintenance } = require("./db/maintenance");

const PORT = process.env.PORT || 3000;
const rawOrigin = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const ALLOWED_ORIGINS = rawOrigin.split(",").map((s) => s.trim());
const IS_PROD = process.env.NODE_ENV === "production";

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", process.env.TRUST_PROXY !== undefined
  ? process.env.TRUST_PROXY
  : (IS_PROD ? 1 : false));

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
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
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
  windowMs:         5 * 60 * 1000,  // 5 minute window
  max:              10,              // 10 attempts per IP per window
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: "Too many registration attempts. Try again in 5 minutes." },
  skipSuccessfulRequests: true,
});

// ─── HTTP + Socket.io ─────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true, methods: ["GET", "POST"] },
});
initSocketHandler(io);
app.set("io", io);
const openapiDocument = fs.readFileSync(path.join(__dirname, "../openapi.yaml"), "utf8");
app.get("/api/docs/openapi.yaml", ...(IS_PROD ? [requireAuth, requireRole("admin")] : []), (_req, res) => {
  res.type("text/yaml").send(openapiDocument);
});
const docsMiddleware = IS_PROD ? [requireAuth, requireRole("admin")] : [];
app.use("/api/docs", ...docsMiddleware, swaggerUi.serve, swaggerUi.setup({
  openapi: "3.0.3",
  info: { title: "PulseWatch API", version: "1.0.0" },
}));

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
app.post("/api/auth/logout", async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) await revokeRefreshToken(refreshToken);
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
      getPublicMonitors().map(async (monitor) => {
        const results       = await getRecentMetrics(monitor.id, 200);
        const hourlyBuckets = await getHourlyBuckets(monitor.id, 90);
        const latest        = results[0] || null;
        const b24 = results.filter((r) => now - new Date(r.timestamp).getTime() < H24);
        const b7  = results.filter((r) => now - new Date(r.timestamp).getTime() < D7);
        const upPct  = (b) => b.length ? parseFloat(((b.filter((r) => r.status === "up").length / b.length) * 100).toFixed(2)) : null;
        const avgLat = (b) => b.length ? Math.round(b.reduce((s, r) => s + (r.responseTime || 0), 0) / b.length) : null;
        return {
          monitorId:     monitor.id,
          url:           monitor.url,
          name:          monitor.name,
          currentStatus: latest?.status ?? "unknown",
          latency:       latest?.responseTime ?? null,
          uptime24h:     upPct(b24),
          uptime7d:      upPct(b7),
          avgLatency24h: avgLat(b24),
          lastChecked:   latest?.timestamp ?? null,
          hourlyBuckets,
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
 * Returns up to 10 resolved incidents per public monitor (via ROW_NUMBER
 * PARTITION BY monitor_id — not a global LIMIT 10), plus any currently
 * ongoing outages from in-memory poller state. No auth required.
 *
 * Restart-persistence note (Phase 4):
 *   OPEN/ACKNOWLEDGED incidents survive server restarts (stored in Postgres).
 *   The ongoing-outage banner is driven by in-memory poller state and may be
 *   absent immediately after restart until the next DOWN check fires.
 *   Startup reconciliation is deferred to a future phase.
 *
 * Response shape:
 *   { incidents: [ ...resolved, ...ongoing ] }  sorted newest-first by startedAt.
 */
app.get("/api/public/incidents", async (_req, res) => {
  try {
    const resolved = await getPublicIncidents();
    const ongoing  = getOngoingOutages();
    // Normalise resolved rows to camelCase for the client
    const resolvedNorm = resolved.map((r) => ({
      monitorId:  r.monitor_id,
      url:        r.url,
      startedAt:  new Date(r.started_at).getTime(),
      resolvedAt: new Date(r.resolved_at).getTime(),
      durationMs: r.duration_ms,
    }));
    const all = [...ongoing, ...resolvedNorm].sort((a, b) => b.startedAt - a.startedAt);
    res.json({ incidents: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Authenticated routes ─────────────────────────────────────────────────────

// Monitors CRUD API
app.use("/api/monitors", monitorsRouter);
app.use("/api/alert-channels", alertChannelsRouter);

app.get("/api/monitors/:id/maintenance", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid monitor ID" });
  try {
    const windows = await getMaintenanceWindows(id, req.user.sub, req.user.role === "admin");
    if (!windows.length && req.user.role !== "admin") {
      const monitor = getMonitorsForUser(req.user.sub, false).find((item) => item.id === id);
      if (!monitor) return res.status(404).json({ error: "Monitor not found" });
    }
    return res.json({ windows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/api/monitors/:id/maintenance", requireAuth, csrfProtect, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const startsAt = new Date(req.body?.starts_at);
  const endsAt = new Date(req.body?.ends_at);
  if (isNaN(id) || isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return res.status(400).json({ error: "Valid starts_at and ends_at with ends_at after starts_at are required" });
  }
  try {
    const window = await createMaintenance({
      monitorId: id, userId: req.user.sub, isAdmin: req.user.role === "admin",
      startsAt, endsAt, reason: req.body.reason,
    });
    if (!window) return res.status(404).json({ error: "Monitor not found" });
    return res.status(201).json({ window });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete("/api/maintenance/:id", requireAuth, csrfProtect, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid maintenance ID" });
  const deleted = await deleteMaintenance(id, req.user.sub, req.user.role === "admin");
  if (!deleted) return res.status(404).json({ error: "Maintenance window not found" });
  return res.json({ message: "Maintenance window deleted" });
});

/**
 * GET /api/incidents?monitorId=<id>&limit=<n>
 * Returns incidents for a single monitor (ownership-scoped).
 */
app.get("/api/incidents", requireAuth, async (req, res) => {
  const monitorId = parseInt(req.query.monitorId, 10);
  const limit     = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const before    = req.query.before;
  if (isNaN(monitorId)) return res.status(400).json({ error: '"monitorId" is required' });

  const isAdmin  = req.user.role === "admin";
  const monitors = getMonitorsForUser(req.user.sub, isAdmin);
  if (!monitors.find((m) => m.id === monitorId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const incidents = await getIncidentsByMonitor({
      monitorId,
      userId: req.user.sub,
      isAdmin,
      limit,
      before,
    });
    return res.json({ monitorId, incidents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/incidents/:id/acknowledge
 * Acknowledges an OPEN incident (ownership-scoped).
 */
app.post("/api/incidents/:id/acknowledge", requireAuth, csrfProtect, async (req, res) => {
  const incidentId = parseInt(req.params.id, 10);
  if (isNaN(incidentId)) return res.status(400).json({ error: "Invalid incident ID" });

  try {
    const isAdmin  = req.user.role === "admin";
    const incident = await acknowledgeIncident({
      incidentId,
      userId: req.user.sub,
      isAdmin,
    });
    if (!incident) return res.status(404).json({ error: "Incident not found or already resolved" });
    broadcastIncidentUpdate({
      type:           "acknowledged",
      monitorId:      incident.monitor_id,
      incidentId:     incident.id,
      acknowledgedAt: new Date(incident.acknowledged_at).getTime(),
    });
    return res.json({ incident });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", requireAuth, async (req, res) => {
  const monitorId = parseInt(req.query.monitorId, 10);
  const n = Math.min(parseInt(req.query.n || "20", 10), 500);
  if (isNaN(monitorId)) return res.status(400).json({ error: '"monitorId" is required' });

  const isAdmin  = req.user.role === "admin";
  const monitors = getMonitorsForUser(req.user.sub, isAdmin);
  const monitor  = monitors.find((m) => m.id === monitorId);
  if (!monitor) return res.status(403).json({ error: "Forbidden" });

  try {
    return res.json({ monitorId, url: monitor.url, results: await getRecentMetrics(monitorId, n) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", requireAuth, async (req, res) => {
  try {
    const isAdmin  = req.user.role === "admin";
    const monitors = getMonitorsForUser(req.user.sub, isAdmin);
    const latest   = {};
    await Promise.all(monitors.map(async (m) => {
      const [r] = await getRecentMetrics(m.id, 1);
      latest[m.id] = { monitor: m, result: r || null };
    }));
    return res.json({ monitors: latest, polling: getPollingState() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/polling-stats", requireAuth, (req, res) => {
  res.json(getPollingState(req.user.sub, req.user.role === "admin"));
});

// ─── Poller → Socket.io bridge ────────────────────────────────────────────────
onResult((result, anomaly) => {
  broadcastMetric({ ...result, anomaly });
  broadcastPollingStats(getPollingState());
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    await runMigrations();
    const admin = await bootstrapAdmin();
    if (admin) console.log(`[Auth] Bootstrapped admin account: ${admin.username}`);
    await loadFromDb();
    httpServer.listen(PORT, () => {
      console.log(`[Server] PulseWatch on http://localhost:${PORT}`);
      console.log(`[Server] CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
      console.log(`[Server] Production mode: ${IS_PROD}`);
      startPolling();
    });
  } catch (err) {
    console.error("[Server] Startup failed:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

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

module.exports = { app, httpServer, startServer };
