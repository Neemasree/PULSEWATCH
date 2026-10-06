# PulseWatch

**Real-time uptime, latency, incident and anomaly monitoring with adaptive polling.**

PulseWatch is a full-stack monitoring system that lets users register HTTP/HTTPS endpoints, continuously monitor them, visualize live latency/status data, detect statistical anomalies, track incidents, and receive Slack alerts.

## Architecture

```
┌─────────────────────┐
│     React UI        │
│   Dashboard / Auth  │
└─────────┬───────────┘
          │ HTTP + Socket.io
          ▼
┌─────────────────────┐
│ Node.js + Express   │
│      + Socket.io    │
└──────┬────────┬─────┘
       │        │
       │        ├──────────────────────┐
       ▼                               ▼
┌───────────────┐              ┌───────────────┐
│  PostgreSQL   │              │     Redis     │
│ users         │              │ metric history│
│ monitors      │              │ incidents     │
│ incidents     │              │ auth state    │
└───────────────┘              └───────────────┘
```

### Why two databases?

- **PostgreSQL** stores relational application data such as users, monitors and incident records.
- **Redis** handles high-frequency monitoring data, time-series metric history, incident cache/history and authentication state such as refresh-token blacklists and login lockouts.

---

## Features

| Feature | Implementation |
|---|---|
| User authentication | JWT access + refresh tokens in httpOnly cookies |
| RBAC | Server-side role checks for protected operations |
| Monitor management | Authenticated monitor CRUD through `/api/monitors` |
| URL monitoring | HTTP/HTTPS endpoint checks with 5-second request timeout |
| SSRF protection | Blocks localhost, private/internal IPs and unsafe DNS resolutions before monitor URLs are saved |
| Adaptive polling | Per-monitor polling interval grows by ×1.5 while healthy |
| Anomaly detection | Z-score detection with `abs(z) > 3`, after at least 10 readings |
| Incident tracking | Opens, acknowledges and resolves downtime incidents |
| Live dashboard | Socket.io pushes metric, polling and incident updates |
| Time-series storage | Redis sorted sets, 7-day metric TTL, maximum 500 metric entries per monitor |
| Incident history | Redis incident history with 30-day TTL and a maximum of 50 stored incidents per monitor |
| Slack alerts | Separate DOWN and anomaly alert flows with independent cooldown handling |
| Security | Helmet, CORS, CSRF protection, rate limiting, bcrypt, token rotation and SSRF validation |
| Testing | Automated coverage for anomaly detection, RBAC, ownership scoping, incidents, pipeline behaviour and SSRF validation |
| Docker | Docker Compose runs Redis, PostgreSQL, backend and frontend together |

---

## Monitoring flow

When a monitor is checked:

```
Monitor
   ↓
pingUrl()
   ↓
HTTP request (5s timeout)
   ↓
Expected-status check
   ↓
Anomaly detection
   ↓
Redis metric storage
   ↓
Incident / Slack alert handling
   ↓
Socket.io broadcast
   ↓
React dashboard update
```

The monitoring engine keeps an independent state for each monitor.

---

## Adaptive polling

Each monitor gets its **own base interval from PostgreSQL**.

Rules:

```
baseInterval = max(configured interval, 5 seconds)

if anomaly OR endpoint is down:
    nextInterval = baseInterval
else:
    nextInterval = min(currentInterval × 1.5,
                       max(60 seconds, baseInterval))
```

So there is **no single global 60-second ceiling**. If a monitor is configured with a base interval above 60 seconds, its ceiling can also be above 60 seconds.

### Why ×1.5?

A healthy endpoint does not need to be checked extremely frequently forever. Gradually increasing the interval reduces unnecessary requests while still maintaining visibility after recovery.

When a problem occurs, polling immediately resets to that monitor's configured base interval.

### Polling comparison

The `/api/polling-stats` endpoint compares adaptive polling against a fixed 10-second baseline and reports the estimated percentage of checks saved.

---

## Anomaly detection

PulseWatch uses a Z-score:

```
z = (value - mean) / standard deviation
```

Implementation:

- Rolling history window: **50 response-time readings**
- Minimum history before detection: **10 readings**
- Threshold: **abs(z) > 3**
- Both unusually high **and unusually low** latency can therefore be classified as anomalies.
- A perfectly flat baseline is handled separately: a different value is treated as anomalous.
- Anomaly detection is implemented as a pure function, making it easy to unit test.

### Why threshold 3?

For a normally distributed variable, approximately 99.7% of values fall within ±3 standard deviations. The threshold therefore focuses alerts on unusually extreme readings rather than ordinary latency jitter.

---

## Alerting

PulseWatch has two distinct Slack alert paths:

### 1. Anomaly alert

Triggered when the Z-score crosses the anomaly threshold.

- Per-monitor/URL cooldown: **5 minutes**
- Prevents repeated anomaly messages from flooding Slack.

### 2. DOWN alert

Triggered when a monitor fails its expected HTTP status or becomes unreachable.

- Has a **separate 5-minute cooldown in `poller.js`**
- The DOWN cooldown does not interfere with anomaly-alert cooldowns.

If Slack is not configured, alerting is skipped without crashing the monitoring loop.

---

## Incident management

When a monitor transitions from UP → DOWN:

1. PulseWatch records the outage start.
2. An incident is opened.
3. A DOWN alert can be sent to Slack.
4. The incident is broadcast through Socket.io.

When the monitor returns DOWN → UP:

1. The incident is resolved.
2. Duration is calculated.
3. The resolution is persisted.
4. The update is broadcast to connected clients.

Incidents can also be acknowledged through the authenticated incident API.

---

## SSRF protection

PulseWatch accepts user-provided monitor URLs, so the backend must not blindly request arbitrary internal addresses.

`ssrf.js` validates URLs by checking:

- Only `http:` and `https:` are allowed.
- `localhost` and `.localhost` are blocked.
- Private IPv4 ranges are blocked.
- Loopback and link-local addresses are blocked.
- IPv6 loopback, unique-local and link-local addresses are blocked.
- DNS resolution is checked so a public-looking hostname cannot resolve to a private/internal address.

This prevents the monitoring service from being abused to access internal infrastructure or cloud metadata endpoints.

---

## Authentication & security

### Token model

| Token | Lifetime | Storage |
|---|---:|---|
| Access token | 15 minutes | httpOnly cookie |
| Refresh token | 7 days | httpOnly cookie |
| CSRF token | 15 minutes | readable cookie + request header |

### Security layers

- **bcrypt** password hashing with cost factor 12
- Separate access and refresh JWT secrets
- Refresh-token rotation
- Server-side refresh-token revocation/blacklisting in Redis
- Account lockout after repeated failed logins
- IP-level login rate limit: 5 failed attempts / 15 minutes
- Registration rate limit: 10 failed attempts / 15 minutes
- CSRF double-submit protection on state-changing routes
- Helmet security headers
- Restricted CORS with credentials
- Server-side RBAC
- Ownership-scoped monitor and incident access
- SSRF validation

---

## REST API

### Authentication

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/register` | POST | Create guest account |
| `/api/auth/login` | POST | Login and issue auth cookies |
| `/api/auth/refresh` | POST | Rotate refresh token |
| `/api/auth/logout` | POST | Revoke refresh token and clear cookies |
| `/api/auth/me` | GET | Return current authenticated user |

### Monitoring

| Endpoint | Method | Description |
|---|---|---|
| `/api/monitors` | GET/POST/DELETE | Monitor CRUD router |
| `/api/check?url=<url>` | GET | On-demand authenticated URL check |
| `/api/history?monitorId=<id>&n=<n>` | GET | Recent metric history |
| `/api/status` | GET | Latest status for accessible monitors |
| `/api/polling-stats` | GET | Adaptive vs fixed polling comparison |

### Incidents

| Endpoint | Method | Description |
|---|---|---|
| `/api/incidents?monitorId=<id>` | GET | Ownership-scoped incident history |
| `/api/incidents/:id/acknowledge` | POST | Acknowledge an incident |

### Public status

| Endpoint | Method | Description |
|---|---|---|
| `/api/public/status` | GET | Public uptime/latency information |
| `/api/public/incidents` | GET | Public resolved and ongoing incidents |
| `/api/health` | GET | Health check |
| `/health` | GET | Health check |

### Diagnostic

| Endpoint | Method | Description |
|---|---|---|
| `/api/debug/cors` | GET | Returns configured allowed origins |

> The debug route is useful during development, but diagnostic endpoints should be restricted or removed from production when they are no longer needed.

---

## WebSocket events

Socket.io is used for real-time dashboard updates.

| Event | Direction | Purpose |
|---|---|---|
| `history` | server → client | Initial/catch-up metric history |
| `metric-update` | server → client | New ping result and anomaly information |
| `polling-stats` | server → client | Updated adaptive polling statistics |
| Incident updates | server → client | Incident opened, acknowledged and resolved events |

---

## Data storage

### Redis metric history

Metrics are stored using Redis sorted sets:

```
metrics:<monitorId>
```

- Score = timestamp
- Retention = **7 days**
- Maximum = **500 newest entries per monitor**

Using the monitor ID instead of the URL keeps histories independent even when two monitors point to the same URL.

### Redis incident history

```
incidents:<monitorId>
```

- Retention = **30 days**
- Maximum = **50 incidents per monitor**

### PostgreSQL

PostgreSQL stores relational application data including:

- Users
- Monitors
- Incidents
- Monitor ownership
- Monitor configuration such as expected HTTP status and polling interval

---

## Docker

Docker Compose runs four services:

```
Redis
PostgreSQL
   ↓
Backend
   ↓
Frontend
```

The Compose configuration provides:

- Container networking
- Redis persistence
- PostgreSQL persistence
- Health checks
- Backend dependency ordering
- Environment-variable based configuration
- Separate frontend/backend containers

### Run locally with Docker

#### Prerequisites

- Docker Desktop

#### Start

```bash
git clone https://github.com/Neemasree/PULSEWATCH.git
cd PULSEWATCH

cp backend/.env.example backend/.env

docker-compose up --build
```

Services:

| Service | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| Backend API | http://localhost:3000 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |

#### Stop

```bash
docker-compose down
```

To also delete the named Redis/PostgreSQL volumes:

```bash
docker-compose down -v
```

---

## Run without Docker

### Backend

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

The backend requires both PostgreSQL and Redis.

### Frontend

```bash
cd frontend
npm install
npm start
```

---

## Project structure

```
PULSEWATCH/
├── backend/
│   ├── src/
│   │   ├── index.js
│   │   ├── pinger.js
│   │   ├── redisClient.js
│   │   ├── poller.js
│   │   ├── anomalyDetector.js
│   │   ├── alerts.js
│   │   ├── ssrf.js
│   │   ├── auth.js
│   │   ├── endpointRegistry.js
│   │   ├── monitorsRouter.js
│   │   ├── socketHandler.js
│   │   └── db/
│   │       ├── pool.js
│   │       ├── monitors.js
│   │       └── incidents.js
│   ├── scripts/
│   │   └── migrate
│   ├── tests/
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── api.js
│   │   ├── App.jsx
│   │   ├── context/
│   │   │   └── AuthContext.jsx
│   │   ├── hooks/
│   │   │   └── useSocket.js
│   │   ├── components/
│   │   │   ├── AppShell.jsx
│   │   │   ├── LatencyChart.jsx
│   │   │   ├── PollingStats.jsx
│   │   │   ├── ProtectedRoute.jsx
│   │   │   └── UrlCard.jsx
│   │   └── pages/
│   │       ├── DashboardPage.jsx
│   │       ├── LoginPage.jsx
│   │       └── StatusPage.jsx
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
│
├── docker-compose.yml
└── render.yaml
```

---

## Testing

The project includes automated tests for important business and security rules, including:

- Anomaly detection
- RBAC
- Monitor ownership scoping
- Incident behaviour
- Monitoring pipeline behaviour
- SSRF URL validation

The anomaly detector is intentionally implemented as a pure function, which makes it deterministic and easy to test.

---

## Environment variables

Typical backend configuration includes:

| Variable | Description |
|---|---|
| `PORT` | Backend HTTP port |
| `REDIS_HOST` | Redis hostname |
| `REDIS_PORT` | Redis port |
| `REDIS_URL` | Optional Redis connection URL |
| `DATABASE_URL` | PostgreSQL connection string |
| `ALLOWED_ORIGIN` | Allowed frontend origin(s) |
| `JWT_ACCESS_SECRET` | Access-token signing secret |
| `JWT_REFRESH_SECRET` | Refresh-token signing secret |
| `SLACK_WEBHOOK_URL` | Optional Slack alert webhook |

**Never commit real secrets or webhook URLs to GitHub.**

---

## Key engineering decisions

### Why Redis?

Monitoring produces frequent time-series writes. Redis sorted sets provide efficient timestamp-based insertion and retrieval while allowing TTL-based cleanup.

### Why PostgreSQL?

Users, monitors and incidents have relational ownership and lifecycle rules that fit PostgreSQL well.

### Why Socket.io?

Polling the server repeatedly from the browser would create unnecessary requests and delay updates. Socket.io lets the backend push new monitoring results to connected clients immediately.

### Why adaptive polling?

Healthy endpoints do not need to be checked at maximum frequency forever. Gradual backoff reduces unnecessary requests while resetting quickly when an endpoint becomes unhealthy or anomalous.

### Why SSRF protection?

The backend makes HTTP requests to user-supplied URLs. Without validation, attackers could potentially use the monitoring server to access internal services.

### Why Docker Compose?

PulseWatch needs multiple services. Compose provides one reproducible command to start the frontend, backend, PostgreSQL and Redis with shared networking and persistent volumes.

---

## Interview-ready project summary

**30-second version:**

> PulseWatch is a full-stack real-time uptime and latency monitoring system. Users can register HTTP/HTTPS endpoints and monitor their health, latency and incidents through a React dashboard. The Node.js/Express backend performs adaptive polling, stores high-frequency metrics in Redis and relational data in PostgreSQL, detects latency anomalies using Z-scores, tracks outages as incidents, and sends Slack alerts. Socket.io pushes live updates to the dashboard, while Docker Compose packages the complete system.

### The five things you should be able to explain

1. **How a URL gets monitored end-to-end**
2. **Why Redis and PostgreSQL are both used**
3. **How adaptive polling works**
4. **How anomaly detection works**
5. **How you secured a server that makes requests to user-provided URLs**

---

## Repository

GitHub: https://github.com/Neemasree/PULSEWATCH
