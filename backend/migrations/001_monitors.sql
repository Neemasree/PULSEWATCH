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

-- Sample monitors are inserted by db/monitors.seedDefaultMonitors() after
-- bootstrapAdmin() runs, so they are always owned by an actual admin account.
