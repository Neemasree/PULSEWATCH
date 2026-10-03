/**
 * scripts/migrate.js
 * Lightweight migration runner with schema_migrations tracking.
 *
 * Runs all pending numbered SQL files in backend/migrations in order
 * within individual database transactions.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const pool = require("../src/db/pool");

async function runMigrations(customPool = pool) {
  const client = await customPool.connect();
  try {
    // 1. Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Fetch already applied migrations
    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.filename));

    // 3. Read migration files
    const migrationsDir = path.join(__dirname, "../migrations");
    if (!fs.existsSync(migrationsDir)) {
      console.warn(`[Migrate] Directory ${migrationsDir} does not exist`);
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // 4. Apply pending migrations sequentially
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      console.log(`[Migrate] Applying ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`[Migrate] Successfully applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[Migrate] Failed to apply ${file}: ${err.message}`);
        throw err;
      }
    }

    console.log("[Migrate] All migrations are up to date.");
  } finally {
    client.release();
  }
}

// Standalone execution via CLI: node scripts/migrate.js
if (require.main === module) {
  require("dotenv").config();
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("[Migrate] Migration script failed:", err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { runMigrations };
