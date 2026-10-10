const pool = require("./pool");

async function upsertCheckRollup(monitorId, result) {
  const hour = new Date(Math.floor(new Date(result.timestamp).getTime() / 3600000) * 3600000);
  await pool.query(
    `INSERT INTO check_rollups (monitor_id, hour, total, up, sum_ms, min_ms, max_ms)
     VALUES ($1, $2, 1, $3::int, $4::int, $4::int, $4::int)
     ON CONFLICT (monitor_id, hour) DO UPDATE SET
       total = check_rollups.total + 1,
       up = check_rollups.up + EXCLUDED.up,
       sum_ms = check_rollups.sum_ms + EXCLUDED.sum_ms,
       min_ms = LEAST(check_rollups.min_ms, EXCLUDED.min_ms),
       max_ms = GREATEST(check_rollups.max_ms, EXCLUDED.max_ms)`,
    [monitorId, hour, result.status === "up" ? 1 : 0, result.responseTime || 0]
  );
}

async function getRollups(monitorId, since) {
  const { rows } = await pool.query(
    `SELECT * FROM check_rollups
     WHERE monitor_id = $1 AND hour >= $2
     ORDER BY hour ASC`,
    [monitorId, since]
  );
  return rows;
}

async function deleteOldRollups() {
  await pool.query("DELETE FROM check_rollups WHERE hour < NOW() - INTERVAL '90 days'");
}

module.exports = { upsertCheckRollup, getRollups, deleteOldRollups };
