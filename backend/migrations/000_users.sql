-- migrations/000_users.sql
-- PulseWatch users table migration.
-- Idempotent: safe to run on fresh or existing databases.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL      PRIMARY KEY,
  username      TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'guest',
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
