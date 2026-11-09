# PulseWatch — placement demo and technical walkthrough

Use this guide to prepare a 3–5 minute demo and answer architecture questions without overstating what the project does.

## 30-second project pitch

PulseWatch is an uptime-monitoring and incident-response platform. A user configures HTTP or HTTPS checks, and the backend monitors them on adaptive per-monitor intervals. It records recent samples, detects unusual latency with a Z-score baseline, creates durable incidents after a configurable failure threshold, and sends filtered notifications to Slack, Discord or a generic webhook. A public status page exposes only monitors marked public.

## Suggested demo flow

1. **Sign in.** Use the admin credentials configured in `backend/.env`, or register a guest account. A first-run admin receives up to five sample public monitors, bounded by `MAX_MONITORS_PER_USER`.
2. **Show the dashboard.** Explain the current state, latency, uptime summaries and live Socket.IO updates.
3. **Create a monitor.** Use a public endpoint you control, or a stable public test endpoint. Configure method, expected status, check interval, timeout and failure threshold. Explain why private, loopback and link-local destinations are rejected.
4. **Open monitor details.** Show recent checks, the statistics window, CSV exports and SSL expiry information for an HTTPS target.
5. **Schedule maintenance.** Create a short future maintenance window and explain that planned checks are excluded from uptime rollups and notifications are suppressed while the window is active.
6. **Review incidents.** Explain the `OPEN → ACKNOWLEDGED → RESOLVED` lifecycle, the unique active-incident constraint and the persisted event timeline.
7. **Show alerts.** Create a webhook channel, choose events, use the test-send action and inspect its delivery history. The application also supports Slack and Discord payload formats.
8. **Show the public status page.** Explain the `is_public` boundary: private monitors do not appear on public status or public incident endpoints.

## Architecture at a glance

| Layer | Responsibility | Main technology |
|---|---|---|
| Browser | Dashboard, monitor management, alerts, incident and status views | React 18, Vite |
| API | Authentication, validation, ownership checks and REST endpoints | Node.js, Express |
| Live updates | Owner/admin rooms for metrics, incidents and polling updates | Socket.IO |
| Monitoring engine | Per-monitor timers, HTTP checks, failure thresholds and anomaly analysis | Node.js, Axios |
| Durable data | Accounts, monitor configuration, incidents, event history, maintenance windows and hourly rollups | PostgreSQL |
| Fast/ephemeral data | Recent raw samples, auth blacklist/lockout TTLs, cooldowns and delivery history | Redis |

## Technical decisions worth explaining

### Adaptive polling

Each monitor has its own base interval and timer. A healthy result gradually increases the next interval by a factor of 1.5 up to a cap; a failure or anomaly resets it to the monitor's base interval. This reduces check volume for healthy services while returning to faster checks when a problem appears.

### Incident correctness

The poller tracks failure thresholds and the current incident in memory for fast decisions, but PostgreSQL is authoritative. A partial unique index allows at most one active incident per monitor. After a process restart, the poller rehydrates an active incident from PostgreSQL instead of assuming that memory is the source of truth.

### Why PostgreSQL and Redis?

PostgreSQL stores durable relational records and hourly check rollups. Redis stores high-frequency recent samples and short-lived authentication/cooldown state. The public uptime summaries are calculated from PostgreSQL rollups, so their history does not disappear when the Redis sample window expires.

### Security boundaries

- Access and refresh tokens are stored in httpOnly cookies. Refresh tokens rotate and are consumed atomically in Redis.
- Mutating browser endpoints use a CSRF cookie/header check.
- Monitor and webhook destinations are validated on save and at connection time; redirects are disabled for outbound checks and webhook delivery.
- User-owned records and Socket.IO updates are scoped to the owning user; admins have explicit broader access.
- Request bodies and custom headers have explicit size/count constraints.
- Hosted PostgreSQL connections verify TLS certificates by default. Proxy trust must be configured explicitly.

## Run locally

### Docker

```bash
git clone https://github.com/Neemasree/PULSEWATCH.git
cd PULSEWATCH
cp backend/.env.example backend/.env
# Set JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ADMIN_USERNAME and ADMIN_PASSWORD.
docker compose up --build
```

Open the dashboard at `http://localhost:8080` and the API health route at `http://localhost:3000/health`. Docker-published ports bind to loopback only.

### Without Docker

Start PostgreSQL and Redis locally, then:

```bash
cd backend
cp .env.example .env
# Use ALLOWED_ORIGIN=http://localhost:5173 for the Vite frontend.
npm ci
npm run migrate
npm run dev
```

In another terminal:

```bash
cd frontend
npm ci
npm run dev
```

OpenAPI documentation is available at `/api/docs` in development. The version-controlled source is `backend/openapi.yaml`.

## Verification commands

```bash
cd backend
npm test
```

```bash
cd frontend
npm ci
npm run build
```

The GitHub Actions workflow runs the backend Jest suite against PostgreSQL and Redis, builds the frontend, and runs Playwright browser workflows. Always check the latest run on `main` before describing a commit as verified.

## Honest limitations to disclose

- **The polling engine is single-instance.** It uses in-process timers; do not run multiple API replicas for the same monitor set until polling ownership is coordinated through a distributed lease or queue.
- **The anomaly detector is a Z-score model.** It needs sufficient history and can be sensitive to skewed distributions; an EWMA or median-absolute-deviation model would be a future improvement.
- **Email notifications are not implemented.** Supported channels are Slack, Discord and generic webhooks.
- **Cooldowns fail open when Redis is unavailable.** Outage notifications are prioritized, but duplicates can occur during a Redis outage.
- **Deployment is intentionally outside this project-completion pass.** The local Docker workflow and CI are included; deployment configuration and live-host behavior must be validated separately.

## Interview questions to rehearse

**Why can a normal 404 be considered down?** The configured expected status is the contract for the monitored endpoint. A check is healthy only when the response matches that expected status and the keyword rules pass.

**How do you avoid duplicate incidents?** The poller has an in-memory fast path, but PostgreSQL enforces the invariant with a partial unique index over active incident statuses. A duplicate insert recovers the existing active incident.

**How do you prevent SSRF?** Validate schemes and URL credentials, reject private/special IP ranges, resolve all DNS addresses, repeat validation at connection time and disable redirects so an unvalidated destination cannot be followed.

**Why use hourly rollups?** They provide durable uptime and average-latency summaries without retaining every raw check forever in PostgreSQL. Redis keeps the recent high-resolution window for charts and diagnostics.

**What changes are required for horizontal scaling?** Move scheduling to a distributed queue or lease-backed scheduler, define one active poller owner per monitor, coordinate check execution and make alert delivery idempotent. Redis cooldowns alone do not make in-process timers distributed.
