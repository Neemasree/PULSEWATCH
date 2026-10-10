/**
 * monitorsRouter.js
 * REST endpoints for managing per-user monitors (/api/monitors).
 *
 * Implements:
 *   GET    /api/monitors
 *   POST   /api/monitors
 *   GET    /api/monitors/:id
 *   PATCH  /api/monitors/:id
 *   DELETE /api/monitors/:id
 *   POST   /api/monitors/:id/pause
 *   POST   /api/monitors/:id/resume
 *
 * All routes require authentication (requireAuth).
 * Mutating routes require CSRF protection (csrfProtect).
 * Access is ownership-scoped: regular users see/edit only their own, admins see/edit all.
 */

const express = require("express");
const { z } = require("zod");
const {
  createMonitor,
  getMonitors,
  getMonitorById,
  updateMonitor,
  deleteMonitor,
  pauseMonitor,
  resumeMonitor,
} = require("./db/monitors");
const {
  notifyMonitorAdded,
  notifyMonitorRemoved,
  notifyMonitorUpdated,
} = require("./endpointRegistry");
const { validateUrlSafety } = require("./ssrf");
const { requireAuth, csrfProtect } = require("./auth");
const { userRoom } = require("./socketHandler");
const { getRecentMetrics } = require("./redisClient");
const { getRollups } = require("./db/rollups");
const { getIncidentsByMonitor } = require("./db/incidents");
const { getSslState } = require("./poller");

const router = express.Router();

// ─── Input Validation Schemas ────────────────────────────────────────────────

const createMonitorSchema = z
  .object({
    name: z
      .string({ required_error: "Name is required" })
      .trim()
      .min(1, "Name must not be empty")
      .max(255, "Name must be at most 255 characters"),
    url: z
      .string({ required_error: "URL is required" })
      .url("Invalid URL format"),
    interval_seconds: z.coerce.number().int().min(5, "Interval must be >= 5s").max(3600, "Interval must be <= 3600s").optional(),
    intervalSeconds: z.coerce.number().int().min(5, "Interval must be >= 5s").max(3600, "Interval must be <= 3600s").optional(),
    expected_status: z.coerce.number().int().min(100, "Status must be >= 100").max(599, "Status must be <= 599").optional(),
    expectedStatus: z.coerce.number().int().min(100, "Status must be >= 100").max(599, "Status must be <= 599").optional(),
    is_public: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    method: z.enum(["GET", "HEAD", "POST"]).optional(),
    request_headers: z.record(z.string(), z.string()).nullable().optional(),
    requestHeaders: z.record(z.string(), z.string()).nullable().optional(),
    request_body: z.string().max(1024 * 1024).nullable().optional(),
    requestBody: z.string().max(1024 * 1024).nullable().optional(),
    keyword: z.string().max(500).nullable().optional(),
    keyword_mode: z.enum(["present", "absent"]).nullable().optional(),
    keywordMode: z.enum(["present", "absent"]).nullable().optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(30000).optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(30000).optional(),
    failure_threshold: z.coerce.number().int().min(1).max(10).optional(),
    failureThreshold: z.coerce.number().int().min(1).max(10).optional(),
    check_ssl: z.boolean().optional(),
    checkSsl: z.boolean().optional(),
  })
  .transform((data) => ({
    name: data.name,
    url: data.url,
    intervalSeconds: data.interval_seconds ?? data.intervalSeconds ?? 10,
    expectedStatus: data.expected_status ?? data.expectedStatus ?? 200,
    isPublic: data.is_public ?? data.isPublic ?? false,
    method: data.method ?? "GET",
    requestHeaders: data.request_headers ?? data.requestHeaders ?? null,
    requestBody: data.request_body ?? data.requestBody ?? null,
    keyword: data.keyword ?? null,
    keywordMode: data.keyword_mode ?? data.keywordMode ?? null,
    timeoutMs: data.timeout_ms ?? data.timeoutMs ?? 5000,
    failureThreshold: data.failure_threshold ?? data.failureThreshold ?? 2,
    checkSsl: data.check_ssl ?? data.checkSsl ?? true,
  }));

const updateMonitorSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    url: z.string().url().optional(),
    interval_seconds: z.coerce.number().int().min(5).max(3600).optional(),
    intervalSeconds: z.coerce.number().int().min(5).max(3600).optional(),
    expected_status: z.coerce.number().int().min(100).max(599).optional(),
    expectedStatus: z.coerce.number().int().min(100).max(599).optional(),
    is_public: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    enabled: z.boolean().optional(),
    method: z.enum(["GET", "HEAD", "POST"]).optional(),
    request_headers: z.record(z.string(), z.string()).nullable().optional(),
    requestHeaders: z.record(z.string(), z.string()).nullable().optional(),
    request_body: z.string().max(1024 * 1024).nullable().optional(),
    requestBody: z.string().max(1024 * 1024).nullable().optional(),
    keyword: z.string().max(500).nullable().optional(),
    keyword_mode: z.enum(["present", "absent"]).nullable().optional(),
    keywordMode: z.enum(["present", "absent"]).nullable().optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(30000).optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(30000).optional(),
    failure_threshold: z.coerce.number().int().min(1).max(10).optional(),
    failureThreshold: z.coerce.number().int().min(1).max(10).optional(),
    check_ssl: z.boolean().optional(),
    checkSsl: z.boolean().optional(),
  })
  .transform((data) => {
    const res = {};
    if (data.name !== undefined) res.name = data.name;
    if (data.url !== undefined) res.url = data.url;
    if (data.interval_seconds !== undefined || data.intervalSeconds !== undefined) {
      res.intervalSeconds = data.interval_seconds ?? data.intervalSeconds;
    }
    if (data.expected_status !== undefined || data.expectedStatus !== undefined) {
      res.expectedStatus = data.expected_status ?? data.expectedStatus;
    }
    if (data.is_public !== undefined || data.isPublic !== undefined) {
      res.isPublic = data.is_public ?? data.isPublic;
    }
    if (data.enabled !== undefined) res.enabled = data.enabled;
    if (data.method !== undefined) res.method = data.method;
    if (data.request_headers !== undefined || data.requestHeaders !== undefined) {
      res.requestHeaders = data.request_headers ?? data.requestHeaders;
    }
    if (data.request_body !== undefined || data.requestBody !== undefined) {
      res.requestBody = data.request_body ?? data.requestBody;
    }
    if (data.keyword !== undefined) res.keyword = data.keyword;
    if (data.keyword_mode !== undefined || data.keywordMode !== undefined) {
      res.keywordMode = data.keyword_mode ?? data.keywordMode;
    }
    if (data.timeout_ms !== undefined || data.timeoutMs !== undefined) {
      res.timeoutMs = data.timeout_ms ?? data.timeoutMs;
    }
    if (data.failure_threshold !== undefined || data.failureThreshold !== undefined) {
      res.failureThreshold = data.failure_threshold ?? data.failureThreshold;
    }
    if (data.check_ssl !== undefined || data.checkSsl !== undefined) {
      res.checkSsl = data.check_ssl ?? data.checkSsl;
    }
    return res;
  });

function emitSocketUpdates(req) {
  const io = req.app.get("io");
  if (io) io.to(userRoom(req.user.sub)).to("admin").emit("monitors-updated");
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/monitors
 * Lists all monitors for the authenticated user (or all if admin).
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const monitors = await getMonitors(req.user.sub, isAdmin);
    return res.json({ monitors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/monitors
 * Creates a new monitor for the authenticated user.
 */
router.post("/", requireAuth, csrfProtect, async (req, res) => {
  // 1. Zod schema validation
  const parseResult = createMonitorSchema.safeParse(req.body);
  if (!parseResult.success) {
    const issues = parseResult.error.issues ?? parseResult.error.errors ?? [];
    const message = issues.map((e) => e.message).join(", ");
    return res.status(400).json({ error: message, details: parseResult.error.format() });
  }

  const { name, url, intervalSeconds, expectedStatus, isPublic, method,
    requestHeaders, requestBody, keyword, keywordMode, timeoutMs, failureThreshold, checkSsl } = parseResult.data;

  // 2. SSRF validation (scheme, hostname, DNS check)
  try {
    await validateUrlSafety(url);
  } catch (err) {
    return res.status(400).json({ error: `SSRF rejected: ${err.message}` });
  }

  // 3. Database insertion with limit check
  try {
    const monitor = await createMonitor({
      userId: req.user.sub,
      name,
      url,
      intervalSeconds,
      expectedStatus,
      isPublic,
      method, requestHeaders, requestBody, keyword, keywordMode, timeoutMs, failureThreshold, checkSsl,
    });

    notifyMonitorAdded(monitor);
    emitSocketUpdates(req);

    return res.status(201).json({ monitor });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/monitors/:id
 * Fetches details for a single monitor.
 */
router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid monitor ID" });

  try {
    const isAdmin = req.user.role === "admin";
    const monitor = await getMonitorById(id, req.user.sub, isAdmin);
    if (!monitor) {
      return res.status(404).json({ error: "Monitor not found" });
    }
    return res.json({ monitor });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const STAT_RANGES = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30, "90d": 24 * 90 };
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

async function scopedMonitor(req, id) {
  return getMonitorById(id, req.user.sub, req.user.role === "admin");
}

router.get("/:id/stats", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const range = req.query.range || "24h";
  if (isNaN(id) || !STAT_RANGES[range]) return res.status(400).json({ error: "Invalid monitor ID or range" });
  const monitor = await scopedMonitor(req, id);
  if (!monitor) return res.status(404).json({ error: "Monitor not found" });
  try {
    const since = new Date(Date.now() - STAT_RANGES[range] * 3600000);
    const [rollups, recent, incidents] = await Promise.all([
      getRollups(id, since),
      getRecentMetrics(id, 500),
      getIncidentsByMonitor({ monitorId: id, userId: req.user.sub, isAdmin: req.user.role === "admin", limit: 200 }),
    ]);
    const total = rollups.reduce((sum, row) => sum + Number(row.total), 0);
    const up = rollups.reduce((sum, row) => sum + Number(row.up), 0);
    const sumMs = rollups.reduce((sum, row) => sum + Number(row.sum_ms), 0);
    const samples = recent.filter((result) => result.status !== "down").map((result) => result.responseTime).sort((a, b) => a - b);
    const percentile = (p) => samples.length ? samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))] : null;
    const resolved = incidents.filter((incident) => incident.status === "RESOLVED");
    const downtime = resolved.reduce((sum, incident) => sum + Number(incident.duration_ms || 0), 0);
    res.json({
      uptimePct: total ? Number((up / total * 100).toFixed(2)) : null,
      avgLatencyMs: total ? Math.round(sumMs / total) : null,
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
      checks: total, incidentCount: incidents.length, totalDowntimeMs: downtime,
      mttrMs: resolved.length ? Math.round(downtime / resolved.length) : null,
      currentStatus: recent[0]?.status || "unknown",
      lastChecked: recent[0]?.timestamp || null,
      ...getSslState(id),
      percentilesBasedOn: "recent-500",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/export.csv", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const range = req.query.range || "24h";
  if (isNaN(id) || !STAT_RANGES[range]) return res.status(400).json({ error: "Invalid monitor ID or range" });
  if (!await scopedMonitor(req, id)) return res.status(404).json({ error: "Monitor not found" });
  try {
    const since = Date.now() - STAT_RANGES[range] * 3600000;
    const results = (await getRecentMetrics(id, 500)).filter((result) => new Date(result.timestamp).getTime() >= since);
    const csv = toCsv(["timestamp", "status", "httpStatus", "responseTimeMs", "failureReason"],
      results.map((result) => [result.timestamp, result.status, result.httpStatus, result.responseTime, result.failureReason]));
    res.type("text/csv").attachment(`monitor-${id}-checks.csv`).send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id/report.csv", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !await scopedMonitor(req, id)) return res.status(404).json({ error: "Monitor not found" });
  try {
    const rows = await getRollups(id, new Date(Date.now() - 90 * 24 * 3600000));
    const csv = toCsv(["hour", "total", "up", "sumMs", "minMs", "maxMs"],
      rows.map((row) => [row.hour, row.total, row.up, row.sum_ms, row.min_ms, row.max_ms]));
    res.type("text/csv").attachment(`monitor-${id}-report.csv`).send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * PATCH /api/monitors/:id
 * Updates an existing monitor.
 */
router.patch("/:id", requireAuth, csrfProtect, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid monitor ID" });

  const parseResult = updateMonitorSchema.safeParse(req.body);
  if (!parseResult.success) {
    const issues = parseResult.error.issues ?? parseResult.error.errors ?? [];
    const message = issues.map((e) => e.message).join(", ");
    return res.status(400).json({ error: message });
  }

  const updates = parseResult.data;

  // SSRF check if url is updated
  if (updates.url) {
    try {
      await validateUrlSafety(updates.url);
    } catch (err) {
      return res.status(400).json({ error: `SSRF rejected: ${err.message}` });
    }
  }

  try {
    const isAdmin = req.user.role === "admin";
    const prev = await getMonitorById(id, req.user.sub, isAdmin);
    if (!prev) {
      return res.status(404).json({ error: "Monitor not found" });
    }

    const updated = await updateMonitor(id, req.user.sub, isAdmin, updates);
    notifyMonitorUpdated(prev, updated);
    emitSocketUpdates(req);

    return res.json({ monitor: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/monitors/:id
 * Deletes a monitor.
 */
router.delete("/:id", requireAuth, csrfProtect, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid monitor ID" });

  try {
    const isAdmin = req.user.role === "admin";
    const deleted = await deleteMonitor(id, req.user.sub, isAdmin);
    if (!deleted) {
      return res.status(404).json({ error: "Monitor not found" });
    }

    notifyMonitorRemoved(deleted);
    emitSocketUpdates(req);

    return res.json({ message: "Monitor deleted", id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/monitors/:id/pause
 * Pauses a monitor (sets enabled = false).
 */
router.post("/:id/pause", requireAuth, csrfProtect, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid monitor ID" });

  try {
    const isAdmin = req.user.role === "admin";
    const prev = await getMonitorById(id, req.user.sub, isAdmin);
    if (!prev) {
      return res.status(404).json({ error: "Monitor not found" });
    }

    const paused = await pauseMonitor(id, req.user.sub, isAdmin);
    notifyMonitorUpdated(prev, paused);
    emitSocketUpdates(req);

    return res.json({ monitor: paused });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/monitors/:id/resume
 * Resumes a paused monitor (sets enabled = true).
 */
router.post("/:id/resume", requireAuth, csrfProtect, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid monitor ID" });

  try {
    const isAdmin = req.user.role === "admin";
    const prev = await getMonitorById(id, req.user.sub, isAdmin);
    if (!prev) {
      return res.status(404).json({ error: "Monitor not found" });
    }

    const resumed = await resumeMonitor(id, req.user.sub, isAdmin);
    notifyMonitorUpdated(prev, resumed);
    emitSocketUpdates(req);

    return res.json({ monitor: resumed });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.emitSocketUpdates = emitSocketUpdates;
