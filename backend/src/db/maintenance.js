const pool = require("./pool");

async function getMaintenanceWindows(monitorId, userId, isAdmin) {
  const ownership = isAdmin ? "" : "AND m.user_id = $2";
  const params = isAdmin ? [monitorId] : [monitorId, userId];
  const { rows } = await pool.query(
    `SELECT w.* FROM maintenance_windows w
     JOIN monitors m ON m.id = w.monitor_id
     WHERE w.monitor_id = $1 ${ownership}
     ORDER BY w.starts_at DESC`,
    params
  );
  return rows;
}

async function getActiveMaintenance(monitorId) {
  const { rows } = await pool.query(
    `SELECT * FROM maintenance_windows
     WHERE monitor_id = $1 AND starts_at <= NOW() AND ends_at > NOW()
     ORDER BY ends_at ASC LIMIT 1`,
    [monitorId]
  );
  return rows[0] || null;
}

async function createMaintenance({ monitorId, userId, isAdmin, startsAt, endsAt, reason }) {
  const monitor = await pool.query(
    isAdmin ? "SELECT id FROM monitors WHERE id = $1" : "SELECT id FROM monitors WHERE id = $1 AND user_id = $2",
    isAdmin ? [monitorId] : [monitorId, userId]
  );
  if (!monitor.rows[0]) return null;
  const { rows } = await pool.query(
    `INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [monitorId, startsAt, endsAt, reason || null, userId]
  );
  return rows[0];
}

async function deleteMaintenance(id, userId, isAdmin) {
  const ownership = isAdmin ? "" : "AND m.user_id = $2";
  const { rows } = await pool.query(
    `DELETE FROM maintenance_windows w USING monitors m
     WHERE w.id = $1 AND w.monitor_id = m.id ${ownership} RETURNING w.*`,
    isAdmin ? [id] : [id, userId]
  );
  return rows[0] || null;
}

module.exports = { getMaintenanceWindows, getActiveMaintenance, createMaintenance, deleteMaintenance };
