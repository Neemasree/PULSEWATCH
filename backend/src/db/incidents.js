/**
 * db/incidents.js
 * PostgreSQL queries for the incidents table.
 *
 * Duplicate-prevention strategy (two layers):
 *   1. Fast path  — poller.js keeps openIncidentId in memory; skips the INSERT
 *      if an incident is already open for this monitor.
 *   2. Safety net — idx_one_open_incident_per_monitor (partial unique index)
 *      rejects a duplicate INSERT at the DB level. openIncident() catches
 *      error code 23505 (unique_violation) and recovers the existing row
 *      instead of crashing.
 *
 * Restart-persistence note (Phase 4):
 *   OPEN/ACKNOWLEDGED incidents survive server restarts (they are in Postgres).
 *   The in-memory openIncidentId in poller.js does NOT survive restarts.
 *   On the first DOWN check after restart the poller will call openIncident();
 *   the unique index will reject the duplicate and this function will return
 *   the existing OPEN row. The public status page ongoing-outage banner is
 *   driven by in-memory state and may be absent immediately after restart
 *   until the next DOWN check fires. Startup reconciliation is deferred to a
 *   future phase.
 */

const pool = require("./pool");

/**
 * Opens a new incident for a monitor.
 * If a unique-constraint violation occurs (duplicate OPEN/ACKNOWLEDGED incident),
 * recovers and returns the existing open row instead of throwing.
 *
 * @param {{ monitorId: number, startedAt: Date|number }} opts
 * @returns {Promise<object>} The incident row (new or existing).
 */
async function openIncident({ monitorId, startedAt }) {
  const startedAtDate = new Date(startedAt);
  try {
    const { rows } = await pool.query(
      `INSERT INTO incidents (monitor_id, status, started_at)
       VALUES ($1, 'OPEN', $2)
       RETURNING *`,
      [monitorId, startedAtDate]
    );
    return rows[0];
  } catch (err) {
    // 23505 = unique_violation — duplicate active incident for this monitor
    if (err.code === "23505") {
      const { rows } = await pool.query(
        `SELECT * FROM incidents
         WHERE monitor_id = $1 AND status IN ('OPEN', 'ACKNOWLEDGED')
         LIMIT 1`,
        [monitorId]
      );
      return rows[0] ?? null;
    }
    throw err;
  }
}

/**
 * Resolves an open incident by ID.
 * Sets status = 'RESOLVED', resolved_at, and duration_ms.
 *
 * @param {{ incidentId: number, resolvedAt: Date|number }} opts
 * @returns {Promise<object|null>}
 */
async function resolveIncident({ incidentId, resolvedAt }) {
  const resolvedAtDate = new Date(resolvedAt);
  const { rows } = await pool.query(
    `UPDATE incidents
     SET status      = 'RESOLVED',
         resolved_at = $2,
         duration_ms = EXTRACT(EPOCH FROM ($2::timestamptz - started_at)) * 1000,
         updated_at  = NOW()
     WHERE id = $1 AND status IN ('OPEN', 'ACKNOWLEDGED')
     RETURNING *`,
    [incidentId, resolvedAtDate]
  );
  return rows[0] ?? null;
}

/**
 * Acknowledges an open incident.
 *
 * @param {{ incidentId: number, userId: number, isAdmin: boolean }} opts
 * @returns {Promise<object|null>}
 */
async function acknowledgeIncident({ incidentId, userId, isAdmin }) {
  // Ownership check: join to monitors to verify user_id unless admin
  const ownershipClause = isAdmin
    ? ""
    : "AND m.user_id = $2";
  const params = isAdmin ? [incidentId, userId] : [incidentId, userId, userId];

  const { rows } = await pool.query(
    `UPDATE incidents i
     SET status           = 'ACKNOWLEDGED',
         acknowledged_at  = NOW(),
          acknowledged_by  = $${isAdmin ? 2 : 3},
         updated_at       = NOW()
     FROM monitors m
     WHERE i.id = $1
       AND i.monitor_id = m.id
       AND i.status = 'OPEN'
       ${ownershipClause}
     RETURNING i.*`,
    params
  );
  return rows[0] ?? null;
}

/**
 * Returns incidents for a single monitor, newest first.
 * Ownership-scoped: regular users can only query their own monitors.
 *
 * @param {{ monitorId: number, userId: number, isAdmin: boolean, limit?: number, before?: string }} opts
 * @returns {Promise<object[]>}
 */
async function getIncidentsByMonitor({ monitorId, userId, isAdmin, limit = 50, before }) {
  const ownershipClause = isAdmin ? "" : "AND m.user_id = $3";
  const cursorClause = before ? `AND i.started_at < $${isAdmin ? 3 : 4}` : "";
  const params = isAdmin ? [monitorId, limit] : [monitorId, limit, userId];
  if (before) params.push(new Date(before));

  const { rows } = await pool.query(
    `SELECT i.*, u.username AS acknowledged_by_username
     FROM incidents i
     JOIN monitors m ON m.id = i.monitor_id
     LEFT JOIN users u ON u.id = i.acknowledged_by
     WHERE i.monitor_id = $1
       ${ownershipClause}
       ${cursorClause}
     ORDER BY i.started_at DESC
     LIMIT $2`,
    params
  );
  return rows;
}

/**
 * Returns up to 10 resolved incidents per public monitor, newest first.
 * Uses ROW_NUMBER() OVER (PARTITION BY monitor_id) to enforce the per-monitor
 * limit correctly — a global LIMIT would silently drop incidents for some monitors.
 *
 * @returns {Promise<object[]>}
 */
async function getPublicIncidents() {
  const { rows } = await pool.query(
    `SELECT id, monitor_id, status, started_at, resolved_at, duration_ms, url
     FROM (
       SELECT i.*,
              m.url,
              ROW_NUMBER() OVER (
                PARTITION BY i.monitor_id
                ORDER BY i.started_at DESC
              ) AS rn
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
       WHERE m.is_public = true
         AND m.enabled   = true
         AND i.status    = 'RESOLVED'
     ) ranked
     WHERE rn <= 10
     ORDER BY started_at DESC`
  );
  return rows;
}

module.exports = {
  openIncident,
  resolveIncident,
  acknowledgeIncident,
  getIncidentsByMonitor,
  getPublicIncidents,
};
