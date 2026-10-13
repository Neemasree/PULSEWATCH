<div align="center">

# ⚡ PulseWatch

### Real-time uptime monitoring & incident response platform

Adaptive polling · Z-score anomaly detection · Incident lifecycle · SSL & maintenance controls · Multi-channel alerts

<br/>

[![Live Demo](https://img.shields.io/badge/🚀_Live_Demo-Open_App-22c55e?style=for-the-badge)](https://YOUR-VERCEL-URL)
[![API](https://img.shields.io/badge/API-Render-46E3B7?style=for-the-badge&logo=render&logoColor=white)](https://YOUR-RENDER-URL/health)
[![CI](https://img.shields.io/github/actions/workflow/status/Neemasree/PULSEWATCH/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI)](https://github.com/Neemasree/PULSEWATCH/actions)
[![Tests](https://img.shields.io/badge/tests-119_passing-22c55e?style=for-the-badge&logo=jest&logoColor=white)](#-testing--ci)

![React](https://img.shields.io/badge/React_18-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=flat-square&logo=socketdotio&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL_16-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis_7-DC382D?style=flat-square&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Jest](https://img.shields.io/badge/Jest-C21325?style=flat-square&logo=jest&logoColor=white)

</div>

<br/>

<!-- Replace with your own screenshot: save it as docs/screenshots/dashboard.png -->
<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="PulseWatch dashboard" width="90%"/>
</p>

---

## 📊 Results

| Metric | Value |
|---|---|
| **Check volume reduction** (adaptive vs fixed 10s polling) | **82%**: 188 adaptive checks vs 1,031 for the fixed baseline |
| Test suite | **119 tests** across 9 suites, run against real PostgreSQL and Redis in CI |
| Anomaly detector coverage | **100%** statements, branches, functions and lines |

> Measured in a local run with 6 healthy monitors. The baseline is a hypothetical fixed 10-second poll, and the figure reflects steady state with healthy monitors; failing or anomalous monitors poll faster, which lowers the saving.

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 📡 Monitoring
- GET / HEAD / POST checks with custom headers and body
- Expected status code, keyword present / absent checks
- Configurable timeout and failure threshold
- **Adaptive polling** that backs off while healthy
- **Z-score anomaly detection** on latency
- **SSL expiry checks** (alerts at 14, 7 and 1 days)
- **Maintenance windows** that silence planned downtime

</td>
<td width="50%" valign="top">

### 🚨 Incident response
- Lifecycle: `OPEN → ACKNOWLEDGED → RESOLVED`
- **One active incident per monitor**, enforced by a partial unique index
- Stats: uptime %, MTTR, avg latency, p50 / p95 / p99
- Hourly rollups in PostgreSQL
- CSV export of checks and hourly reports
- Public status page for chosen monitors

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔔 Alerting
- Slack, Discord and generic webhook channels
- Per-channel event filters: `down` · `recovered` · `anomaly` · `ssl_expiring`
- Test-send button and delivery log
- Webhook destinations re-validated against SSRF

</td>
<td width="50%" valign="top">

### 🔐 Security
- JWT access + refresh in httpOnly cookies, **rotation**
- Redis-backed **token blacklist** and **login lockout**
- CSRF protection, Helmet, CORS allow-list, rate limiting
- **SSRF and DNS-rebinding protection**
- Ownership-scoped queries, per-user Socket.io rooms

</td>
</tr>
</table>

---

## 🏗️ Architecture

### System overview

```mermaid
flowchart LR
  subgraph CLIENT["🖥️ Client"]
    UI["React + Vite<br/>Dashboard · Monitors · Alerts · Status page"]
  end

  subgraph API["🟢 API layer · Node + Express"]
    direction TB
    MW["Middleware<br/>Helmet · CORS · CSRF · rate limit · Zod"]
    AUTH["Auth<br/>JWT rotation · RBAC · ownership checks"]
    REST["REST routes<br/>monitors · incidents · alerts · stats"]
    WS["Socket.io<br/>per-user rooms"]
  end

  subgraph ENGINE["⚙️ Monitoring engine"]
    direction TB
    POLL["Poller<br/>one adaptive timer per monitor"]
    PING["Pinger<br/>SSRF-safe HTTP agent"]
    ANOM["Anomaly detector<br/>z-score"]
    INC["Incident manager<br/>state machine"]
    SSL["SSL checker"]
    NOTIF["Notifier<br/>alert channels"]
  end

  subgraph DATA["🗄️ Data layer"]
    PG[("PostgreSQL<br/>users · monitors · incidents<br/>rollups · channels · maintenance")]
    RD[("Redis<br/>recent checks · token blacklist<br/>lockout · delivery logs")]
  end

  subgraph EXT["🌐 External"]
    SITES["Monitored websites"]
    HOOKS["Slack · Discord · Webhooks"]
  end

  UI -->|"REST + cookies"| MW
  MW --> AUTH --> REST
  UI <-->|"live updates"| WS
  REST <--> PG
  AUTH <--> RD

  POLL --> PING
  PING -->|"HTTP checks"| SITES
  PING --> ANOM
  ANOM --> INC
  POLL --> SSL
  INC --> PG
  INC --> NOTIF
  SSL --> NOTIF
  NOTIF -->|"alerts"| HOOKS
  POLL --> RD
  ANOM --> WS
  INC --> WS

  classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A,stroke-width:2px
  classDef api fill:#DCFCE7,stroke:#16A34A,color:#14532D,stroke-width:2px
  classDef engine fill:#FEF3C7,stroke:#D97706,color:#78350F,stroke-width:2px
  classDef pg fill:#E0E7FF,stroke:#4F46E5,color:#312E81,stroke-width:2px
  classDef redis fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D,stroke-width:2px
  classDef ext fill:#F3E8FF,stroke:#9333EA,color:#581C87,stroke-width:2px

  class UI client
  class MW,AUTH,REST,WS api
  class POLL,PING,ANOM,INC,SSL,NOTIF engine
  class PG pg
  class RD redis
  class SITES,HOOKS ext
```

> 🟦 client &nbsp; 🟩 API &nbsp; 🟨 monitoring engine &nbsp; 🟪 PostgreSQL / external &nbsp; 🟥 Redis

### What happens on every check

```mermaid
sequenceDiagram
  autonumber
  participant P as ⏱️ Poller
  participant H as 🌐 Pinger
  participant S as 🌍 Target site
  participant A as 📈 Anomaly detector
  participant I as 🚨 Incident manager
  participant DB as 🗄️ PostgreSQL
  participant R as ⚡ Redis
  participant N as 🔔 Notifier
  participant U as 🖥️ Dashboard

  P->>H: run check for monitor
  H->>S: HTTP request (DNS re-validated)
  S-->>H: status, latency, body
  H-->>P: result (up / down)
  P->>R: store raw sample
  P->>A: compare latency to rolling baseline
  A-->>P: normal or anomaly (z-score above 3)

  alt failure threshold reached
    P->>I: open incident
    I->>DB: INSERT (partial unique index prevents duplicates)
    I->>N: send "down" alert
  else recovered while incident active
    P->>I: resolve incident
    I->>DB: set resolved_at, duration
    I->>N: send "recovered" alert
  end

  P->>DB: upsert hourly rollup
  P->>U: Socket.io update to owner room
  P->>P: schedule next check (adaptive interval)
```

### Adaptive polling

```mermaid
flowchart LR
  START(["Check completes"]) --> Q{"Result?"}
  Q -->|"✅ Healthy"| UP["Interval × 1.5<br/>up to the cap"]
  Q -->|"⚠️ Anomaly"| RESET["Reset to base interval"]
  Q -->|"❌ Down"| RESET
  UP --> NEXT(["Schedule next check"])
  RESET --> NEXT

  classDef good fill:#DCFCE7,stroke:#16A34A,color:#14532D,stroke-width:2px
  classDef warn fill:#FEF3C7,stroke:#D97706,color:#78350F,stroke-width:2px
  classDef neutral fill:#E0E7FF,stroke:#4F46E5,color:#312E81,stroke-width:2px
  class UP good
  class RESET warn
  class START,NEXT,Q neutral
```

A healthy monitor settles at the cap (60 s with the default base), a saving of about 1 − 10/60 ≈ 83% against a fixed 10 s baseline. Any anomaly or failure drops it straight back to the fast interval, so problems are never watched slowly.

### Incident lifecycle

```mermaid
stateDiagram-v2
  [*] --> OPEN: failure threshold reached
  OPEN --> ACKNOWLEDGED: user acknowledges
  OPEN --> RESOLVED: monitor recovers
  ACKNOWLEDGED --> RESOLVED: monitor recovers
  RESOLVED --> [*]

  classDef open fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D
  classDef ack fill:#FEF3C7,stroke:#D97706,color:#78350F
  classDef done fill:#DCFCE7,stroke:#16A34A,color:#14532D
  class OPEN open
  class ACKNOWLEDGED ack
  class RESOLVED done
```

A partial unique index on `incidents(monitor_id) WHERE status IN ('OPEN','ACKNOWLEDGED')` guarantees at most one active incident per monitor, even if two checks race.

---

## 🧠 Design decisions

<details>
<summary><b>Why PostgreSQL and Redis together?</b></summary>
<br/>

Configuration, incidents and aggregated history must be durable and queryable, so they live in PostgreSQL. High-frequency raw samples, auth state with TTLs and delivery logs suit Redis. Raw checks are not stored in PostgreSQL; they are rolled up hourly to keep the database small. Percentiles use the latest 500 Redis samples, while uptime and averages come from hourly rollups.
</details>

<details>
<summary><b>Why gradual back-off for adaptive polling?</b></summary>
<br/>

Jumping straight to a long interval would leave a blind spot just after recovery. Growing by ×1.5 per healthy check (similar to TCP slow-start) cuts load quickly while still reacting fast: any anomaly or failure resets to the base interval.
</details>

<details>
<summary><b>Why enforce incident uniqueness in the database?</b></summary>
<br/>

Application-level "check then insert" logic can race. A partial unique index makes duplicate active incidents impossible regardless of timing or the number of workers.
</details>

<details>
<summary><b>Why keep auth state in Redis?</b></summary>
<br/>

The refresh-token blacklist and login lockout counters use Redis keys with TTLs, so a restart never revives a revoked token or resets a lockout.
</details>

<details>
<summary><b>How is SSRF handled?</b></summary>
<br/>

User-supplied URLs (monitors and webhook destinations) are validated on save and again on use. Private, loopback and link-local addresses are rejected, and DNS is checked at connection time to defeat rebinding.
</details>

---

## 🚀 Getting started

### With Docker (recommended)

```bash
git clone https://github.com/Neemasree/PULSEWATCH.git
cd PULSEWATCH
cp backend/.env.example backend/.env
# edit backend/.env: set JWT secrets, ADMIN_USERNAME and ADMIN_PASSWORD
docker compose up --build
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| Backend API | http://localhost:3000 |

Generate each JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Without Docker

```bash
# backend (needs PostgreSQL and Redis running)
cd backend && npm install && npm run migrate && npm run dev

# frontend
cd frontend && npm install && npm run dev
```

<details>
<summary><b>Environment variables</b></summary>
<br/>

| Variable | Description |
|---|---|
| `PORT` | Backend port (default 3000) |
| `NODE_ENV` | `development` or `production` |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | Set to `false` for local Postgres without SSL |
| `REDIS_URL` or `REDIS_HOST` / `REDIS_PORT` | Redis connection |
| `ALLOWED_ORIGIN` | Frontend origin(s) for CORS, comma-separated |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Required in production, use different values |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Bootstrap admin, created only if none exists |
| `TRUST_PROXY` | `false` locally, `1` behind Render / Vercel |
| `SLACK_WEBHOOK_URL` | Optional legacy fallback alert destination |

</details>

---

## 🔌 API overview

OpenAPI docs are served at `/api/docs` (open in development, admin-only in production).

<details>
<summary><b>Show routes</b></summary>
<br/>

| Area | Routes |
|---|---|
| Auth | `POST /api/auth/register`, `/login`, `/refresh`, `/logout`, `GET /api/auth/me` |
| Monitors | `GET/POST /api/monitors`, `GET/PATCH/DELETE /api/monitors/:id`, `POST /:id/pause`, `POST /:id/resume` |
| Monitor data | `GET /api/monitors/:id/stats`, `/export.csv`, `/report.csv`, `GET /api/history?monitorId=`, `GET /api/status` |
| Incidents | `GET /api/incidents`, `GET /api/incidents/:id/events`, `POST /api/incidents/:id/acknowledge` |
| Alert channels | `GET/POST /api/alert-channels`, `PATCH/DELETE /:id`, `POST /:id/test`, `GET /:id/deliveries` |
| Maintenance | `GET/POST /api/monitors/:id/maintenance`, `DELETE /api/maintenance/:id` |
| Public | `GET /api/public/status`, `GET /api/public/incidents` |
| Health | `GET /health`, `GET /api/health` |

**Socket.io events (server to client):** `history`, `metric-update`, `polling-stats`, `incident-update`. Each is sent only to the owning user's room (and admins).

</details>

---

## 🧪 Testing & CI

```bash
cd backend
npm test                 # 9 suites, 119 tests
npm test -- --coverage   # coverage report
```

Suites cover monitor CRUD and validation, incident transitions, ownership scoping, SSRF protection, auth hardening, Redis-backed auth state, the polling pipeline and anomaly detection.

GitHub Actions ([`ci.yml`](.github/workflows/ci.yml)) runs on every push and pull request: it starts PostgreSQL 16 and Redis 7 service containers, applies migrations, runs the backend tests, and builds the frontend.

---

## ☁️ Deployment

| Part | Platform | Notes |
|---|---|---|
| Frontend | Vercel | `vercel.json` rewrites all routes to `index.html` |
| Backend | Render | `render.yaml` provisions the web service, PostgreSQL and Redis with generated JWT secrets and a `/health` check |

> Free-tier instances sleep when idle, which pauses background polling. Use an always-on instance for continuous monitoring.

---

## ⚠️ Known limitations and current scope

- **Single-instance polling:** polling still runs in-process with `setTimeout`. Do not scale the backend horizontally until polling ownership is coordinated through a shared scheduler/queue (for example, BullMQ) or a distributed lease.
- **Anomaly model:** Z-score detection can be sensitive to skewed latency distributions and small samples. MAD or EWMA is a future improvement; review alerts against your workload before treating them as definitive.
- **Email alerts:** email delivery is not implemented. Current supported alert channels are Slack, Discord and generic webhooks.
- **Redis outage behavior:** down-alert cooldown acquisition fails open if Redis is unavailable, prioritizing outage notifications over duplicate suppression during the outage.
- **MTTA definition:** MTTA is currently calculated from the incident's `started_at` to `acknowledged_at`; incidents that have not been acknowledged have a null MTTA. This is a duration, not a pre-aggregated service-level metric.

The Redis-backed cooldown is shared across backend processes, and incident lifecycle events are persisted in PostgreSQL and available through the ownership-scoped `GET /api/incidents/:id/events` endpoint. These features do not make the polling scheduler multi-instance safe.

---

<div align="center">

Built by **[Neema Sree K](https://github.com/Neemasree)** · See [LICENSE](LICENSE)

</div>
