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

-- Seed the admin account (password: admin123)
INSERT INTO users (id, username, password_hash, role, name)
VALUES (
  1,
  'admin',
  '$2a$12$VcE5NzZRTU6uDxvgIwwqIezVfYGWE1TsnE8NcVW2k4p.Bm96ZWve2',
  'admin',
  'Admin User'
) ON CONFLICT (username) DO NOTHING;

-- Reset sequence
SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 1));
