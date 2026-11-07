/**
 * db/pool.js
 * Shared pg Pool instance for the entire backend.
 *
 * Why a Pool instead of a Client?
 *   A Pool maintains a set of persistent connections and hands them out
 *   on demand. Creating a new TCP connection per query would add ~20-100ms
 *   of overhead on every request. The Pool amortises that cost.
 *
 * Why a module-level singleton?
 *   Node's module cache means this file is evaluated once. Every require()
 *   of this module gets the same Pool instance — no accidental double-pools.
 *
 * Configuration:
 *   Set DATABASE_URL in .env for a connection string (Railway, Supabase, etc.)
 *   or set PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD individually.
 *   pg reads all PG* environment variables automatically via libpq conventions.
 */

const { Pool } = require("pg");
const { getDatabaseSslConfig } = require("./poolConfig");

// pg reads DATABASE_URL automatically if set; individual PG* vars otherwise.
// max:10 is the pg default but stated explicitly for clarity.
// idleTimeoutMillis: close idle connections after 30s to avoid exhausting
// the free-tier connection limit on hosted Postgres (e.g. Railway: 20 max).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                    10,
  idleTimeoutMillis:  30_000,
  connectionTimeoutMillis: 5_000,
  // Hosted Postgres uses TLS with certificate verification by default.
  // Explicitly opt out only when a provider requires a custom/self-signed CA.
  ssl: getDatabaseSslConfig(
    process.env.DATABASE_URL,
    process.env.DATABASE_SSL,
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
    process.env.PGHOST
  ),
});

pool.on("connect", () => console.log("[DB] Postgres connected"));
pool.on("error",  (err) => console.error("[DB] Unexpected Postgres error:", err.message));

module.exports = pool;
