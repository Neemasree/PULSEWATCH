-- Long-range hourly statistics and incident acknowledgement attribution.

CREATE TABLE IF NOT EXISTS check_rollups (
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hour TIMESTAMPTZ NOT NULL,
  total INT NOT NULL DEFAULT 0,
  up INT NOT NULL DEFAULT 0,
  sum_ms BIGINT NOT NULL DEFAULT 0,
  min_ms INT,
  max_ms INT,
  PRIMARY KEY (monitor_id, hour)
);

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_check_rollups_monitor_hour ON check_rollups(monitor_id, hour DESC);
