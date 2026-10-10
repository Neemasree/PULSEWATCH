CREATE TABLE IF NOT EXISTS alert_channels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('slack', 'discord', 'webhook')),
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  events JSONB NOT NULL DEFAULT '["down","recovered","anomaly","ssl_expiring"]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_channels_user_id ON alert_channels(user_id);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id SERIAL PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_monitor_time
  ON maintenance_windows(monitor_id, starts_at, ends_at);
