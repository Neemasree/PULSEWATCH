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
  bootstrapAdmin, getFirstAdmin,
  requireAuth, requireRole, csrfProtect,
  setAuthCookies, clearAuthCookies,
} = require("./auth");

const { getRecentMetrics } = require("./redisClient");
const { seedDefaultMonitors } = require("./db/monitors");
const { startPolling, onResult, getPollingState, getOngoingOutages, getMonitorsForUser } = require("./poller");
const { loadFromDb, getPublicMonitors } = require("./endpointRegistry");
const { runMigrations }         = require("../scripts/migrate");
const monitorsRouter            = require("./monitorsRouter");
const alertChannelsRouter       = require("./alertChannelsRouter");
const { initSocketHandler, broadcastMetric, broadcastPollingStats, broadcastIncidentUpdate } = require("./socketHandler");
const { getPublicIncidents, getPublicOngoingIncidents, getIncidentsByMonitor, getIncidentEvents, acknowledgeIncident } = require("./db/incidents");
const { getMaintenanceWindows, createMaintenance, deleteMaintenance } = require("./db/maintenance");
const { getRollups } = require("./db/rollups");

const PORT = process.env.PORT || 3000;
const rawOrigin = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const ALLOWED_ORIGINS = rawOrigin.split(",").map((s) => s.trim());
const IS_PROD = process.env.NODE_ENV === "production";

function parsePositiveId(raw) {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
const rawTrustProxy = process.env.TRUST_PROXY;
// Never trust forwarded client IP headers implicitly. Operators must set
// TRUST_PROXY to the actual proxy hop count or trusted subnet when deployed.
const trustProxy = rawTrustProxy === undefined || rawTrustProxy === "false"
  ? false
  : (isNaN(Number(rawTrustProxy)) ? rawTrustProxy : Number(rawTrustProxy));
app.set("trust proxy", trustProxy);

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
app.use(express.json({ limit: "1mb" }));
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
const openapiPath = path.join(__dirname, "../openapi.yaml");
const openapiDocument = fs.existsSync(openapiPath) ? fs.readFileSync(openapiPath, "utf8") : null;
if (openapiDocument) {
  app.get("/api/docs/openapi.yaml", ...(IS_PROD ? [requireAuth, requireRole("admin")] : []), (_req, res) => {
    res.type("text/yaml").send(openapiDocument);
  });
}
const docsMiddleware = IS_PROD ? [requireAuth, requireRole("admin")] : [];
app.use("/api/docs", ...docsMiddleware, swaggerUi.serve, swaggerUi.setup(null, {
  swaggerOptions: {
    // Load the version-controlled OpenAPI document served by the route above.
    url: "/api/docs/openapi.yaml",
    persistAuthorization: true,
  },
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
    // Keep responses identical for unknown, incorrect and locked accounts.
    return res.status(401).json({ error: "Invalid credentials" });
  }
});

/**
 * POST /api/auth/register
 * Creates a new guest account. Returns user info + sets auth cookies.
 * Body: { username, password, name }
 */
app.post("/api/auth/register", registerLimiter, async (req, res) => {
  const { username, password, name } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || typeof name !== "string" ||
      !username.trim() || !password || !name.trim()) {
    return res.status(400).json({ error: "Username, password and name are required" });
  }
  try {
    const { accessToken, refreshToken, user } = await register(username, password, name);
    setAuthCookies(res, accessToken, refreshToken);
    return res.status(201).json({ user });
  } catch (err) {
    const status = err.status || (err.code ? 500 : 400);
    if (status >= 500) console.error("[Auth] Registration failed:", err.message);
    return res.status(status).json({ error: status >= 500 ? "Unable to register" : err.message });
  }
});

/**
 * POST /api/auth/refresh
 * Reads the refresh_token cookie, rotates it, sets new cookies.
 * No CSRF check here — this route only reads a cookie, produces another cookie,
 * and returns no data that could be used in a CSRF attack.
 */
app.post("/api/auth/refresh", csrfProtect, async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

  try {
    const { accessToken, refreshToken: newRefresh, user } = await rotateRefreshToken(refreshToken);
    setAuthCookies(res, accessToken, newRefresh);
    return res.json({ user });
  } catch (err) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/**
 * POST /api/auth/logout
 * Blacklists the refresh token server-side and clears all auth cookies.
 * Without server-side blacklisting, clearing the cookie still leaves a valid
 * 7-day token that a stolen cookie could replay.
 */
app.post("/api/auth/logout", csrfProtect, async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  try {
    if (refreshToken) await revokeRefreshToken(refreshToken);
    clearAuthCookies(res);
    return res.json({ message: "Logged out" });
  } catch (err) {
    console.error("[Auth] Logout revocation failed:", err.message);
    clearAuthCookies(res);
    return res.status(503).json({ error: "Logout could not be completed; please retry" });
  }
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
    const D7 = 7 * H24;
    const D90 = 90 * 24 * H24;
    const currentDay = Math.floor(now / (24 * H24));
    const startDay = currentDay - 89; // exactly 90 daily buckets

    const services = await Promise.all(
      getPublicMonitors().map(async (monitor) => {
        const [results, rollups] = await Promise.all([
          getRecentMetrics(monitor.id, 1),
          getRollups(monitor.id, new Date(now - D90)),
        ]);
        const latest = results[0] || null;
        const summarise = (rows) => {
          const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
          const up = rows.reduce((sum, row) => sum + Number(row.up || 0), 0);
          const sumMs = rows.reduce((sum, row) => sum + Number(row.sum_ms || 0), 0);
          return {
            uptime: total ? Number(((up / total) * 100).toFixed(2)) : null,
            averageLatency: total ? Math.round(sumMs / total) : null,
            total,
            up,
          };
        };
        const dayTotals = new Map();
        for (const row of rollups) {
          const day = Math.floor(new Date(row.hour).getTime() / (24 * H24));
          const item = dayTotals.get(day) || { total: 0, up: 0 };
          item.total += Number(row.total || 0);
          item.up += Number(row.up || 0);
          dayTotals.set(day, item);
        }
        const hourlyBuckets = [];
        for (let day = startDay; day <= currentDay; day++) {
          const item = dayTotals.get(day);
          if (!item || item.total === 0) hourlyBuckets.push("unknown");
          else if (item.up === item.total) hourlyBuckets.push("up");
          else if (item.up === 0) hourlyBuckets.push("down");
          else hourlyBuckets.push("degraded");
        }
        const last24 = summarise(rollups.filter((row) => new Date(row.hour).getTime() >= now - H24));
        const last7d = summarise(rollups.filter((row) => new Date(row.hour).getTime() >= now - D7));
        return {
          monitorId: monitor.id,
          url: monitor.url,
          name: monitor.name,
          currentStatus: latest?.maintenance ? "maintenance" : (latest?.status ?? "unknown"),
          latency: latest?.responseTime ?? null,
          uptime24h: last24.uptime,
          uptime7d: last7d.uptime,
          avgLatency24h: last24.averageLatency,
          lastChecked: latest?.timestamp ?? null,
          hourlyBuckets,
        };
      })
    );
    res.json({ services, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[PublicStatus] Query failed:", err.message);
    res.status(500).json({ error: "Unable to load public status" });
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
    const [resolved, ongoingRows] = await Promise.all([
      getPublicIncidents(),
      getPublicOngoingIncidents(),
    ]);
    // PostgreSQL is authoritative for active incidents. Do not depend on the
    // poller's in-memory state, which is empty immediately after a restart.
    const ongoing = ongoingRows.map((row) => ({
      monitorId: row.monitor_id,
      url: row.url,
      startedAt: new Date(row.started_at).getTime(),
      ongoing: true,
      status: row.status,
    }));
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
    console.error("[API] Public incident query failed:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Authenticated routes ─────────────────────────────────────────────────────

// Monitors CRUD API
app.use("/api/monitors", monitorsRouter);
app.use("/api/alert-channels", alertChannelsRouter);

app.get("/api/monitors/:id/maintenance", requireAuth, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid monitor ID" });
  try {
    const windows = await getMaintenanceWindows(id, req.user.sub, req.user.role === "admin");
    if (!windows.length && req.user.role !== "admin") {
      const monitor = getMonitorsForUser(req.user.sub, false).find((item) => item.id === id);
      if (!monitor) return res.status(404).json({ error: "Monitor not found" });
    }
    return res.json({ windows });
  } catch (err) {
    console.error("[API] Maintenance query failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/monitors/:id/maintenance", requireAuth, csrfProtect, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid monitor ID" });

  const startsAtRaw = req.body?.starts_at;
  const endsAtRaw = req.body?.ends_at;
  if (typeof startsAtRaw !== "string" || typeof endsAtRaw !== "string") {
    return res.status(400).json({ error: "starts_at and ends_at must be ISO date strings" });
  }
  const startsAt = new Date(startsAtRaw);
  const endsAt = new Date(endsAtRaw);
  const durationMs = endsAt.getTime() - startsAt.getTime();
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) ||
      durationMs <= 0 || durationMs > 365 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: "Maintenance window must have valid dates and last no more than 365 days" });
  }
  const reason = req.body.reason;
  if (reason !== undefined && reason !== null &&
      (typeof reason !== "string" || reason.trim().length > 300)) {
    return res.status(400).json({ error: "Maintenance reason must be a string of at most 300 characters" });
  }
  try {
    const window = await createMaintenance({
      monitorId: id, userId: req.user.sub, isAdmin: req.user.role === "admin",
      startsAt, endsAt, reason: typeof reason === "string" ? reason.trim() || null : null,
    });
    if (!window) return res.status(404).json({ error: "Monitor not found" });
    return res.status(201).json({ window });
  } catch (err) {
    console.error("[API] Maintenance creation failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/maintenance/:id", requireAuth, csrfProtect, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid maintenance ID" });
  try {
    const deleted = await deleteMaintenance(id, req.user.sub, req.user.role === "admin");
    if (!deleted) return res.status(404).json({ error: "Maintenance window not found" });
    return res.json({ message: "Maintenance window deleted" });
  } catch (err) {
    console.error("[API] Maintenance deletion failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/incidents?monitorId=<id>&limit=<n>
 * Returns incidents for a single monitor (ownership-scoped).
 */
app.get("/api/incidents", requireAuth, async (req, res) => {
  const monitorIdRaw = req.query.monitorId;
  const limitRaw = req.query.limit ?? "50";
  const before = req.query.before;

  // Reject malformed query values instead of silently parsing prefixes such
  // as "12oops" or passing invalid timestamps into PostgreSQL.
  if (typeof monitorIdRaw !== "string" || !/^[0-9]+$/.test(monitorIdRaw) || !Number.isSafeInteger(Number(monitorIdRaw)) || Number(monitorIdRaw) < 1) {
    return res.status(400).json({ error: '"monitorId" must be a positive integer' });
  }
  if (typeof limitRaw !== "string" || !/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
    return res.status(400).json({ error: '"limit" must be a positive integer' });
  }
  if (before !== undefined && (
    typeof before !== "string" || before.trim() === "" || !Number.isFinite(Date.parse(before))
  )) {
    return res.status(400).json({ error: '"before" must be a valid date timestamp' });
  }

  const monitorId = Number(monitorIdRaw);
  const limit = Math.min(Number(limitRaw), 200);

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
    console.error("[API] Request failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/incidents/:id/events
 * Returns the durable lifecycle timeline for an incident, ownership-scoped.
 */
app.get("/api/incidents/:id/events", requireAuth, async (req, res) => {
  const incidentIdRaw = req.params.id;
  if (!/^[0-9]+$/.test(incidentIdRaw) || !Number.isSafeInteger(Number(incidentIdRaw)) || Number(incidentIdRaw) < 1) {
    return res.status(400).json({ error: "Incident ID must be a positive integer" });
  }
  const incidentId = Number(incidentIdRaw);

  try {
    const events = await getIncidentEvents({
      incidentId,
      userId: req.user.sub,
      isAdmin: req.user.role === "admin",
    });
    // An empty timeline may mean the incident does not exist or is not visible
    // to this user; avoid leaking cross-user incident IDs.
    if (!events.length) return res.status(404).json({ error: "Incident not found" });
    return res.json({ incidentId, events });
  } catch (err) {
    console.error("[API] Request failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/incidents/:id/acknowledge
 * Acknowledges an OPEN incident (ownership-scoped).
 */
app.post("/api/incidents/:id/acknowledge", requireAuth, csrfProtect, async (req, res) => {
  const incidentIdRaw = req.params.id;
  if (!/^[0-9]+$/.test(incidentIdRaw) || !Number.isSafeInteger(Number(incidentIdRaw)) || Number(incidentIdRaw) < 1) {
    return res.status(400).json({ error: "Incident ID must be a positive integer" });
  }
  const incidentId = Number(incidentIdRaw);

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
    console.error("[API] Request failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/history", requireAuth, async (req, res) => {
  const monitorIdRaw = req.query.monitorId;
  const limitRaw = req.query.n ?? "20";
  if (typeof monitorIdRaw !== "string" || !/^[0-9]+$/.test(monitorIdRaw) ||
      !Number.isSafeInteger(Number(monitorIdRaw)) || Number(monitorIdRaw) < 1) {
    return res.status(400).json({ error: '"monitorId" must be a positive integer' });
  }
  if (typeof limitRaw !== "string" || !/^[0-9]+$/.test(limitRaw) ||
      !Number.isSafeInteger(Number(limitRaw)) || Number(limitRaw) < 1) {
    return res.status(400).json({ error: '"n" must be a positive integer' });
  }

  const monitorId = Number(monitorIdRaw);
  const n = Math.min(Number(limitRaw), 500);

  const isAdmin  = req.user.role === "admin";
  const monitors = getMonitorsForUser(req.user.sub, isAdmin);
  const monitor  = monitors.find((m) => m.id === monitorId);
  if (!monitor) return res.status(403).json({ error: "Forbidden" });

  try {
    return res.json({ monitorId, url: monitor.url, results: await getRecentMetrics(monitorId, n) });
  } catch (err) {
    console.error("[API] History query failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
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
    return res.json({
      monitors: latest,
      polling: getPollingState(req.user.sub, isAdmin),
    });
  } catch (err) {
    console.error("[API] Status query failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/polling-stats", requireAuth, (req, res) => {
  res.json(getPollingState(req.user.sub, req.user.role === "admin"));
});

// Centralized parser/CORS/unexpected error response. Route-level async handlers
// keep their own domain responses; this prevents raw stack traces from leaking.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body exceeds the 1 MB limit" });
  }
  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, "body")) {
    return res.status(400).json({ error: "Invalid JSON request body" });
  }
  if (typeof err.message === "string" && err.message.startsWith("CORS:")) {
    return res.status(403).json({ error: "Origin is not allowed" });
  }
  console.error("[HTTP] Unhandled request error:", err.message);
  return res.status(500).json({ error: "Internal server error" });
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
    const createdAdmin = await bootstrapAdmin();
    if (createdAdmin) console.log(`[Auth] Bootstrapped admin account: ${createdAdmin.username}`);
    const admin = createdAdmin || await getFirstAdmin();
    if (admin) {
      const seededCount = await seedDefaultMonitors(admin.id);
      if (seededCount) console.log(`[Setup] Seeded ${seededCount} sample monitors for admin ${admin.username}`);
    }
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
