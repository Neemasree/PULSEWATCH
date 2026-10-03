-- migrations/001_monitors.sql
-- PulseWatch monitors table migration.

CREATE TABLE IF NOT EXISTS monitors (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  url              TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 10 CHECK (interval_seconds >= 5),
  expected_status  INTEGER NOT NULL DEFAULT 200,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  is_public        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id);

-- Seed the 5 existing hardcoded URLs as monitors owned by admin user (id: 1) with is_public = true
INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
SELECT 1, 'Google', 'https://www.google.com', 10, 200, true, true
WHERE NOT EXISTS (SELECT 1 FROM monitors WHERE user_id = 1 AND url = 'https://www.google.com');

INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
SELECT 1, 'GitHub', 'https://www.github.com', 10, 200, true, true
WHERE NOT EXISTS (SELECT 1 FROM monitors WHERE user_id = 1 AND url = 'https://www.github.com');

INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
SELECT 1, 'Cloudflare', 'https://www.cloudflare.com', 10, 200, true, true
WHERE NOT EXISTS (SELECT 1 FROM monitors WHERE user_id = 1 AND url = 'https://www.cloudflare.com');

INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
SELECT 1, 'HTTPBin', 'https://httpbin.org/get', 10, 200, true, true
WHERE NOT EXISTS (SELECT 1 FROM monitors WHERE user_id = 1 AND url = 'https://httpbin.org/get');

INSERT INTO monitors (user_id, name, url, interval_seconds, expected_status, enabled, is_public)
SELECT 1, 'JSONPlaceholder', 'https://jsonplaceholder.typicode.com/posts/1', 10, 200, true, true
WHERE NOT EXISTS (SELECT 1 FROM monitors WHERE user_id = 1 AND url = 'https://jsonplaceholder.typicode.com/posts/1');
