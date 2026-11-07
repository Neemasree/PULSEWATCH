const pool = require("./pool");

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname ? "/***" : ""}`;
  } catch {
    return "***";
  }
}

function safeChannel(row) {
  return { ...row, target_url: maskUrl(row.target_url) };
}

async function listChannels(userId, isAdmin) {
  const { rows } = await pool.query(
    isAdmin ? "SELECT * FROM alert_channels ORDER BY id" : "SELECT * FROM alert_channels WHERE user_id = $1 ORDER BY id",
    isAdmin ? [] : [userId]
  );
  return rows.map(safeChannel);
}

async function getChannel(id, userId, isAdmin) {
  const { rows } = await pool.query(
    isAdmin ? "SELECT * FROM alert_channels WHERE id = $1" : "SELECT * FROM alert_channels WHERE id = $1 AND user_id = $2",
    isAdmin ? [id] : [id, userId]
  );
  return rows[0] || null;
}

async function countChannels(userId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM alert_channels WHERE user_id = $1", [userId]);
  return rows[0].count;
}

async function createChannel(data) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Serialize creates for one owner so concurrent requests cannot bypass
    // the per-user channel quota.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      ["pulsewatch:alert-channel-limit", String(data.userId)]
    );
    const count = await db.query(
      "SELECT COUNT(*)::int AS count FROM alert_channels WHERE user_id = $1",
      [data.userId]
    );
    if (count.rows[0].count >= 10) {
      const error = new Error("Maximum of 10 alert channels reached");
      error.code = "CHANNEL_LIMIT_REACHED";
      throw error;
    }

    const { rows } = await db.query(
      `INSERT INTO alert_channels (user_id, type, name, target_url, enabled, events)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [data.userId, data.type, data.name, data.target_url ?? data.targetUrl, data.enabled, JSON.stringify(data.events)]
    );
    await db.query("COMMIT");
    return safeChannel(rows[0]);
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function deleteChannel(id, userId, isAdmin) {
  const { rows } = await pool.query(
    isAdmin ? "DELETE FROM alert_channels WHERE id = $1 RETURNING id" : "DELETE FROM alert_channels WHERE id = $1 AND user_id = $2 RETURNING id",
    isAdmin ? [id] : [id, userId]
  );
  return rows[0] || null;
}

module.exports = { maskUrl, safeChannel, listChannels, getChannel, countChannels, createChannel, deleteChannel };
