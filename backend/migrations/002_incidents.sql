-- migrations/002_incidents.sql
-- PulseWatch incidents table.
-- Idempotent: safe to run on fresh or existing databases.
--
-- Design notes:
--   - status is constrained to OPEN | ACKNOWLEDGED | RESOLVED.
--   - The partial unique index idx_one_open_incident_per_monitor enforces that
--     each monitor can have at most one active (OPEN or ACKNOWLEDGED) incident
--     at the database level. This is the final safety net; the in-memory
--     openIncidentId guard in poller.js is the fast runtime check.
--   - ON DELETE CASCADE means deleting a monitor also deletes its incidents.
--   - duration_ms is stored in milliseconds for easy MTTA/MTTR arithmetic.
--
-- Restart-persistence note (Phase 4):
--   OPEN and ACKNOWLEDGED incidents survive server restarts because they are
--   persisted here immediately when the outage is first detected.
--   However, the in-memory poller state (downSince, openIncidentId) is lost on
--   restart. On the next DOWN check after restart the poller will attempt to
--   open a new incident; the partial unique index will reject the duplicate
--   INSERT and openIncident() will recover the existing OPEN row instead.
--   The public status page ongoing-outage banner (getOngoingOutages) is driven
--   by in-memory state and may therefore be absent immediately after restart
--   until the next DOWN check fires. This is a known Phase 4 limitation;
--   startup reconciliation will be addressed in a future phase.

CREATE TABLE IF NOT EXISTS incidents (
  id               SERIAL      PRIMARY KEY,
  monitor_id       INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status           TEXT        NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  started_at       TIMESTAMPTZ NOT NULL,
  acknowledged_at  TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  duration_ms      INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookups by monitor
CREATE INDEX IF NOT EXISTS idx_incidents_monitor_id
  ON incidents(monitor_id);

-- Fast lookups by status (e.g. find all OPEN incidents)
CREATE INDEX IF NOT EXISTS idx_incidents_status
  ON incidents(status);

-- Fast time-ordered queries
CREATE INDEX IF NOT EXISTS idx_incidents_started_at
  ON incidents(started_at DESC);

-- DATABASE-LEVEL DUPLICATE PREVENTION:
-- At most one OPEN or ACKNOWLEDGED incident per monitor at any time.
-- The poller's in-memory openIncidentId is the fast path; this index is the
-- authoritative guard that survives process restarts and concurrent workers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_incident_per_monitor
  ON incidents(monitor_id)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED');
