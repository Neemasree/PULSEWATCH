-- Configurable request and failure behavior for monitors.

ALTER TABLE monitors
  ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'GET'
    CHECK (method IN ('GET', 'HEAD', 'POST')),
  ADD COLUMN IF NOT EXISTS request_headers JSONB,
  ADD COLUMN IF NOT EXISTS request_body TEXT,
  ADD COLUMN IF NOT EXISTS keyword TEXT,
  ADD COLUMN IF NOT EXISTS keyword_mode TEXT
    CHECK (keyword_mode IN ('present', 'absent')),
  ADD COLUMN IF NOT EXISTS timeout_ms INT NOT NULL DEFAULT 5000
    CHECK (timeout_ms BETWEEN 1000 AND 30000),
  ADD COLUMN IF NOT EXISTS failure_threshold INT NOT NULL DEFAULT 2
    CHECK (failure_threshold BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS check_ssl BOOLEAN NOT NULL DEFAULT true;
