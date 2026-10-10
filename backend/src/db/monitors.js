/**
 * db/monitors.js
 * Database queries for the monitors table.
 * All queries are parameterized and ownership-scoped.
 */

const pool = require("./pool");

const MAX_MONITORS_DEFAULT = 20;

function getMaxMonitorsPerUser() {
  const envVal = parseInt(process.env.MAX_MONITORS_PER_USER, 10);
  return isNaN(envVal) || envVal <= 0 ? MAX_MONITORS_DEFAULT : envVal;
}

/**
 * Creates a new monitor for a user, enforcing the MAX_MONITORS_PER_USER limit.
 */
async function createMonitor({
  userId,
  name,
  url,
  intervalSeconds = 10,
  expectedStatus = 200,
  isPublic = false,
  method = "GET",
  requestHeaders = null,
  requestBody = null,
  keyword = null,
  keywordMode = null,
  timeoutMs = 5000,
  failureThreshold = 2,
  checkSsl = true,
}) {
  const maxLimit = getMaxMonitorsPerUser();

  // Check per-user monitor count
  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS count FROM monitors WHERE user_id = $1",
    [userId]
  );
  const currentCount = countResult.rows[0]?.count || 0;

  if (currentCount >= maxLimit) {
    const error = new Error(`Monitor limit reached (${maxLimit} max per user)`);
    error.status = 400;
    throw error;
  }

  const { rows } = await pool.query(
    `INSERT INTO monitors (
       user_id, name, url, interval_seconds, expected_status, enabled, is_public,
       method, request_headers, request_body, keyword, keyword_mode, timeout_ms,
       failure_threshold, check_ssl, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
     RETURNING *`,
    [userId, name, url, intervalSeconds, expectedStatus, isPublic, method,
      requestHeaders, requestBody, keyword, keywordMode, timeoutMs, failureThreshold, checkSsl]
  );

  return rows[0];
}

/**
 * Retrieves all monitors visible to the caller:
 * - Regular users: only their own monitors
 * - Admins: all monitors in the system
 */
async function getMonitors(userId, isAdmin = false) {
  if (isAdmin) {
    const { rows } = await pool.query(
      "SELECT * FROM monitors ORDER BY id ASC"
    );
    return rows;
  }

  const { rows } = await pool.query(
    "SELECT * FROM monitors WHERE user_id = $1 ORDER BY id ASC",
    [userId]
  );
  return rows;
}

/**
 * Retrieves a single monitor by ID, scoped by ownership.
 */
async function getMonitorById(id, userId, isAdmin = false) {
  const query = isAdmin
    ? "SELECT * FROM monitors WHERE id = $1"
    : "SELECT * FROM monitors WHERE id = $1 AND user_id = $2";
  const params = isAdmin ? [id] : [id, userId];

  const { rows } = await pool.query(query, params);
  return rows[0] ?? null;
}

/**
 * Updates a monitor's fields, scoped by ownership.
 */
async function updateMonitor(id, userId, isAdmin, fields) {
  const existing = await getMonitorById(id, userId, isAdmin);
  if (!existing) return null;

  const updates = [];
  const values = [];
  let paramIdx = 1;

  if (fields.name !== undefined) {
    updates.push(`name = $${paramIdx++}`);
    values.push(fields.name);
  }
  if (fields.url !== undefined) {
    updates.push(`url = $${paramIdx++}`);
    values.push(fields.url);
  }
  if (fields.intervalSeconds !== undefined) {
    updates.push(`interval_seconds = $${paramIdx++}`);
    values.push(fields.intervalSeconds);
  }
  if (fields.expectedStatus !== undefined) {
    updates.push(`expected_status = $${paramIdx++}`);
    values.push(fields.expectedStatus);
  }
  if (fields.isPublic !== undefined) {
    updates.push(`is_public = $${paramIdx++}`);
    values.push(fields.isPublic);
  }
  if (fields.enabled !== undefined) {
    updates.push(`enabled = $${paramIdx++}`);
    values.push(fields.enabled);
  }
  const columnMap = {
    method: "method",
    requestHeaders: "request_headers",
    requestBody: "request_body",
    keyword: "keyword",
    keywordMode: "keyword_mode",
    timeoutMs: "timeout_ms",
    failureThreshold: "failure_threshold",
    checkSsl: "check_ssl",
  };
  for (const [field, column] of Object.entries(columnMap)) {
    if (fields[field] !== undefined) {
      updates.push(`${column} = $${paramIdx++}`);
      values.push(fields[field]);
    }
  }

  updates.push(`updated_at = NOW()`);

  values.push(id);
  const whereIdParam = paramIdx++;

  let whereClause = `WHERE id = $${whereIdParam}`;
  if (!isAdmin) {
    values.push(userId);
    whereClause += ` AND user_id = $${paramIdx++}`;
  }

  const sql = `
    UPDATE monitors
    SET ${updates.join(", ")}
    ${whereClause}
    RETURNING *
  `;

  const { rows } = await pool.query(sql, values);
  return rows[0] ?? null;
}

/**
 * Deletes a monitor, scoped by ownership.
 */
async function deleteMonitor(id, userId, isAdmin = false) {
  const query = isAdmin
    ? "DELETE FROM monitors WHERE id = $1 RETURNING *"
    : "DELETE FROM monitors WHERE id = $1 AND user_id = $2 RETURNING *";
  const params = isAdmin ? [id] : [id, userId];

  const { rows } = await pool.query(query, params);
  return rows[0] ?? null;
}

/**
 * Sets a monitor's enabled status to false.
 */
async function pauseMonitor(id, userId, isAdmin = false) {
  return updateMonitor(id, userId, isAdmin, { enabled: false });
}

/**
 * Sets a monitor's enabled status to true.
 */
async function resumeMonitor(id, userId, isAdmin = false) {
  return updateMonitor(id, userId, isAdmin, { enabled: true });
}

/**
 * Retrieves all currently enabled monitors across all users (for poller startup).
 */
async function getAllEnabledMonitors() {
  const { rows } = await pool.query(
    "SELECT * FROM monitors WHERE enabled = true ORDER BY id ASC"
  );
  return rows;
}

/**
 * Retrieves all public enabled monitors (for public status page).
 */
async function getPublicEnabledMonitors() {
  const { rows } = await pool.query(
    "SELECT * FROM monitors WHERE enabled = true AND is_public = true ORDER BY id ASC"
  );
  return rows;
}

module.exports = {
  createMonitor,
  getMonitors,
  getMonitorById,
  updateMonitor,
  deleteMonitor,
  pauseMonitor,
  resumeMonitor,
  getAllEnabledMonitors,
  getPublicEnabledMonitors,
  getMaxMonitorsPerUser,
};
