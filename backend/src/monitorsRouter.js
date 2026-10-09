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
  })
  .transform((data) => ({
    name: data.name,
    url: data.url,
    intervalSeconds: data.interval_seconds ?? data.intervalSeconds ?? 10,
    expectedStatus: data.expected_status ?? data.expectedStatus ?? 200,
    isPublic: data.is_public ?? data.isPublic ?? false,
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

  const { name, url, intervalSeconds, expectedStatus, isPublic } = parseResult.data;

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
