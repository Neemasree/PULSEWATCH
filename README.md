# PulseWatch

Real-time uptime and latency monitor with adaptive polling and anomaly detection.

```
┌─────────────┐   WebSocket    ┌──────────────┐
│   React UI  │ ◄────────────► │   Express    │
│  (port 8080)│                │  + Socket.io │
└─────────────┘                │  (port 3000) │
                               └──────┬───────┘
                                      │ ioredis
                               ┌──────▼───────┐
                               │    Redis     │
                               │  (port 6379) │
                               └──────────────┘
```

## Features

| Feature | Implementation |
|---|---|
| On-demand URL ping | `GET /check?url=` — returns status, latency, timestamp |
| Background monitoring | 5 URLs, adaptive polling (5s – 60s dynamic interval) |
| Time-series storage | Redis sorted sets, 1-hour TTL, 500 entries max per URL |
| Live dashboard | Socket.io pushes every result; Chart.js shows last 20 per URL |
| Anomaly detection | Z-score > 3 (99.7% confidence) triggers Slack alert |
| Adaptive polling | Healthy → ×1.5 back-off (max 60s). Anomalous → reset to 5s |

---

## Run locally with Docker (recommended)

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### 1. Clone and configure

```bash
cd pulsewatch
cp backend/.env.example backend/.env
# Edit backend/.env — set SLACK_WEBHOOK_URL if you want Slack alerts
```

### 2. Start everything

```bash
docker-compose up --build
```

This builds both images and starts Redis, the backend, and the frontend in one command.

| Service | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| Backend API | http://localhost:3000 |
| Redis | localhost:6379 |

### 3. Stop

```bash
docker-compose down          # stops containers, keeps Redis data
docker-compose down -v       # stops containers AND deletes Redis data
```

---

## Run locally without Docker

### Backend

```bash
cd backend
npm install
cp .env.example .env         # fill in values
npm run dev                  # nodemon hot-reload
```

Requires Redis running on `localhost:6379`. Quick option: `docker run -p 6379:6379 redis:7.2-alpine`

### Frontend

```bash
cd frontend
npm install
npm start                    # CRA dev server on http://localhost:3000
                             # proxies /api/* to backend via package.json "proxy"
```

---

## REST API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness check |
| `/check?url=<url>` | GET | On-demand ping |
| `/history?url=<url>&n=<n>` | GET | Last N results for a URL |
| `/status` | GET | Latest result for all monitored URLs |
| `/polling-stats` | GET | Adaptive vs fixed polling comparison |

---

## WebSocket events

Connect to `http://localhost:3000` with `socket.io-client`.

| Event | Direction | Payload |
|---|---|---|
| `history` | server → client | `{ [url]: result[] }` — sent once on connect (catch-up) |
| `metric-update` | server → client | Single ping result with anomaly info |
| `polling-stats` | server → client | Adaptive vs fixed check count comparison |

---

## Anomaly detection

Uses z-score: `z = (value − mean) / stdDev`

- Baseline: rolling window of the last 50 response times per URL
- Threshold: z > 3 (a value more than 3 standard deviations above the mean)
- Minimum data: 10 readings required before detection activates (avoids false alarms on startup)
- Alert channel: Slack incoming webhook (set `SLACK_WEBHOOK_URL` in `.env`)
- Cooldown: one alert per URL per 5 minutes (prevents channel flooding)

---

## Adaptive polling algorithm

Each URL has an independent timer. On every completed check:

```
if anomalous or down:
    nextInterval = MIN (5s)       ← sharp reset, maximum visibility
else:
    nextInterval = min(current × 1.5, MAX)   ← gradual back-off
```

Bounds: minimum 5s, maximum 60s, start 10s.

**Why ×1.5 and not jump to 60s?**
Jumping to max immediately creates a blind spot right after recovery. Gradual growth means we keep checking frequently for a while after things look healthy. Analogous to TCP slow-start: increase window size gradually, reset sharply on congestion.

**Why have bounds at all?**
Without a minimum, intervals could shrink toward 0 and DoS target servers.
Without a maximum, intervals could grow so large we'd almost never check a healthy service.

The `/polling-stats` endpoint and the dashboard panel both show the real-time comparison: adaptive checks made vs. what a fixed 10s interval would have made over the same period. Run for a few hours and capture the `savedPct` field — that's your resume number.

---

## Project structure

```
pulsewatch/
├── backend/
│   ├── src/
│   │   ├── index.js        Express server + Socket.io wiring
│   │   ├── pinger.js       HTTP ping with timeout handling
│   │   ├── storage.js      Redis sorted-set read/write
│   │   ├── anomaly.js      detectAnomaly(readings, newValue) → { isAnomaly, zScore }
│   │   ├── alerter.js      Slack webhook with cooldown
│   │   └── poller.js       Adaptive polling engine
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── index.js
│   │   ├── hooks/
│   │   │   └── useSocket.js
│   │   └── components/
│   │       ├── StatusBar.jsx
│   │       ├── UrlCard.jsx
│   │       ├── LatencyChart.jsx
│   │       └── PollingStats.jsx
│   ├── public/index.html
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
└── docker-compose.yml
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Backend HTTP port |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `SLACK_WEBHOOK_URL` | _(empty)_ | Slack incoming webhook — alerting disabled if unset |
