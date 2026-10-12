-- Persistent incident lifecycle history.
-- Idempotent so the migration can safely be applied to fresh databases.
CREATE TABLE IF NOT EXISTS incident_events (
  id BIGSERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('OPENED', 'ACKNOWLEDGED', 'RESOLVED')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident_created
  ON incident_events(incident_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_incident_events_created
  ON incident_events(created_at DESC);
