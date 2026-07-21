-- migrate.sql
-- PulseWatch users table migration.
--
-- Run once against your Postgres database:
--   psql $DATABASE_URL -f src/db/migrate.sql
--
-- Safe to re-run — CREATE TABLE IF NOT EXISTS and INSERT ... ON CONFLICT
-- mean it won't fail or duplicate data on subsequent runs.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL      PRIMARY KEY,
  username      TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'guest',
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the admin account using the same bcrypt-12 hash that was
-- previously hardcoded in auth.js (password: admin123).
-- ON CONFLICT DO NOTHING makes this idempotent — re-running the
-- migration won't duplicate the row or overwrite a changed password.
INSERT INTO users (id, username, password_hash, role, name)
VALUES (
  1,
  'admin',
  '$2a$12$1wTTPDn0x4ZL6I9JfNWY3uou.466dAZlY1rfpC3i3frzF9KNwCSJy',
  'admin',
  'Admin User'
) ON CONFLICT (username) DO NOTHING;

-- Reset the sequence so the next auto-generated id starts at 2,
-- not 1 (which is taken by the seeded admin row above).
SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 1));
