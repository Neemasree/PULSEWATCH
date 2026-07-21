/**
 * StatusPage.jsx
 * Public status page — no authentication required.
 * Standalone page, like status.github.com or status.vercel.com.
 * Polls /api/public/status every 30 s.
 */

import React, { useEffect, useState } from "react";
import { api } from "../api";

const REFRESH_MS = 30_000;

function barColor(state) {
  if (state === "up")       return "#48bb78";
  if (state === "degraded") return "#ecc94b";
  if (state === "down")     return "#fc8181";
  return "#2d3748";
}

export default function StatusPage() {
  const [data,        setData]        = useState(null);
  const [incidents,   setIncidents]   = useState([]);
  const [error,       setError]       = useState("");
  const [loading,     setLoading]     = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  async function fetchStatus() {
    try {
      const res = await api.publicStatus();
      setData(res);
      setLastUpdated(new Date());
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchIncidents() {
    try {
      const res = await api.publicIncidents();
      setIncidents(res.incidents || []);
    } catch {
      // Non-fatal — incidents section just stays empty
    }
  }

  useEffect(() => {
    fetchStatus();
    fetchIncidents();
    const t1 = setInterval(fetchStatus,   REFRESH_MS);
    const t2 = setInterval(fetchIncidents, REFRESH_MS);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  const allUp      = data?.services?.every((s) => s.currentStatus === "up");
  const anyDown    = data?.services?.some((s) => s.currentStatus === "down");
  const overallStatus = loading ? "loading"
    : error       ? "error"
    : anyDown     ? "down"
    : !allUp      ? "degraded"
    : "operational";

  return (
    <div style={s.page}>

      {/* ── Top nav bar ───────────────────────────────────────────── */}
      <header style={s.topbar}>
        <div style={s.topbarInner}>
          <a href="/" style={s.brand}>
            <span style={s.brandIcon}>⚡</span>
            <span style={s.brandName}>PulseWatch</span>
          </a>
          <a href="/dashboard" style={s.dashLink}>
            Go to Dashboard →
          </a>
        </div>
      </header>

      {/* ── Hero banner ────────────────────────────────────────────── */}
      <div style={s.hero(overallStatus)}>
        <div style={s.heroInner}>
          <div style={s.heroIcon(overallStatus)}>
            {overallStatus === "operational" ? "✓"
              : overallStatus === "degraded"   ? "⚠"
              : overallStatus === "down"        ? "✕"
              : "…"}
          </div>
          <div>
            <h1 style={s.heroTitle}>
              {overallStatus === "operational" ? "All Systems Operational"
                : overallStatus === "degraded"   ? "Partial System Degradation"
                : overallStatus === "down"        ? "Service Disruption"
                : overallStatus === "loading"     ? "Checking systems…"
                : "Unable to fetch status"}
            </h1>
            {lastUpdated && (
              <p style={s.heroSub}>
                Last updated {lastUpdated.toLocaleTimeString()} · Auto-refreshes every 30 s
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Main content ───────────────────────────────────────────── */}
      <div style={s.container}>

        {/* Loading / error states */}
        {loading && (
          <div style={s.placeholder}>
            <div style={s.spinner} />
            <span>Fetching service status…</span>
          </div>
        )}
        {error && !loading && (
          <div style={s.errorBox}>
            <span style={{ fontSize: "18px" }}>⚠</span>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Unable to load status</div>
              <div style={{ fontSize: "13px", opacity: 0.8 }}>{error}</div>
            </div>
          </div>
        )}

        {/* Services section */}
        {data?.services?.length > 0 && (
          <section style={s.section}>
            <div style={s.sectionHeader}>
              <h2 style={s.sectionTitle}>Services</h2>
              <span style={s.sectionMeta}>{data.services.length} monitored</span>
            </div>

            <div style={s.serviceList}>
              {data.services.map((svc) => (
                <ServiceRow key={svc.url} svc={svc} />
              ))}
            </div>
          </section>
        )}

        {/* Uptime summary cards */}
        {data?.services?.length > 0 && (
          <section style={s.section}>
            <div style={s.sectionHeader}>
              <h2 style={s.sectionTitle}>Uptime Summary</h2>
              <span style={s.sectionMeta}>Last 7 days</span>
            </div>
            <div style={s.summaryGrid}>
              {data.services.map((svc) => (
                <UptimeCard key={svc.url} svc={svc} />
              ))}
            </div>
          </section>
        )}

        {/* Metrics overview */}
        {data?.services?.length > 0 && (
          <section style={s.section}>
            <div style={s.sectionHeader}>
              <h2 style={s.sectionTitle}>Performance</h2>
              <span style={s.sectionMeta}>Current response times</span>
            </div>
            <div style={s.metricsGrid}>
              {data.services.map((svc) => (
                <LatencyCard key={svc.url} svc={svc} />
              ))}
            </div>
          </section>
        )}

        {/* Incident history */}
        <section style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>Incident History</h2>
            <span style={s.sectionMeta}>
              {incidents.length === 0 ? "No incidents recorded" : `${incidents.length} incident${incidents.length !== 1 ? "s" : ""}`}
            </span>
          </div>
          {incidents.length === 0 ? (
            <div style={ih.empty}>
              <span style={ih.emptyIcon}>✓</span>
              No incidents in the last 30 days
            </div>
          ) : (
            <div style={ih.list}>
              {incidents.map((inc, i) => (
                <IncidentRow key={i} inc={inc} />
              ))}
            </div>
          )}
        </section>

      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer style={s.footer}>
        <div style={s.footerInner}>
          <span>⚡ PulseWatch · Powered by adaptive polling + anomaly detection</span>
          <span style={s.footerRight}>
            {data && <>Data as of {new Date(data.generatedAt).toLocaleString()}</>}
          </span>
        </div>
      </footer>

    </div>
  );
}

// ── Service Row ───────────────────────────────────────────────────────────────
function ServiceRow({ svc }) {
  const isUp   = svc.currentStatus === "up";
  const name   = svc.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  // Use real per-hour buckets from Redis (array of "up"|"down"|"unknown", oldest→newest).
  // Fall back to all-unknown if the server hasn't returned them yet.
  const bars   = svc.hourlyBuckets ?? Array(90).fill("unknown");

  return (
    <div style={sr.row}>
      {/* Left: status dot + name */}
      <div style={sr.left}>
        <span style={sr.dot(isUp)} />
        <div>
          <div style={sr.name}>{name}</div>
          <a href={svc.url} target="_blank" rel="noopener noreferrer" style={sr.url}>
            {svc.url}
          </a>
        </div>
      </div>

      {/* Middle: uptime bar */}
      <div style={sr.barWrap}>
        {bars.map((state, i) => (
          <div key={i} style={sr.bar(state)} title={state} />
        ))}
        <span style={sr.barLabel}>90 days</span>
      </div>

      {/* Right: uptime % + badge */}
      <div style={sr.right}>
        <span style={sr.uptime(svc.uptime7d)}>
          {svc.uptime7d != null ? `${svc.uptime7d}%` : "—"}
        </span>
        <span style={sr.badge(isUp)}>
          {svc.currentStatus.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

// ── Uptime Card ───────────────────────────────────────────────────────────────
function UptimeCard({ svc }) {
  const name = svc.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  return (
    <div style={uc.card}>
      <div style={uc.cardName}>{name}</div>
      <div style={uc.row}>
        <span style={uc.label}>24 h</span>
        <UptimeBar pct={svc.uptime24h} />
        <span style={{ ...uc.pct, color: uptimeColor(svc.uptime24h) }}>
          {svc.uptime24h != null ? `${svc.uptime24h}%` : "—"}
        </span>
      </div>
      <div style={uc.row}>
        <span style={uc.label}>7 d</span>
        <UptimeBar pct={svc.uptime7d} />
        <span style={{ ...uc.pct, color: uptimeColor(svc.uptime7d) }}>
          {svc.uptime7d != null ? `${svc.uptime7d}%` : "—"}
        </span>
      </div>
    </div>
  );
}

function UptimeBar({ pct }) {
  const width = pct != null ? `${pct}%` : "0%";
  const color = uptimeColor(pct);
  return (
    <div style={{ flex: 1, background: "#1a202c", borderRadius: 4, height: 6, overflow: "hidden" }}>
      <div style={{ width, height: "100%", background: color, borderRadius: 4, transition: "width 0.4s" }} />
    </div>
  );
}

// ── Latency Card ──────────────────────────────────────────────────────────────
function LatencyCard({ svc }) {
  const name    = svc.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const isUp    = svc.currentStatus === "up";
  const latency = svc.latency;
  const avg     = svc.avgLatency24h;

  const latencyLevel = !latency ? "unknown"
    : latency < 300  ? "fast"
    : latency < 800  ? "normal"
    : latency < 2000 ? "slow"
    : "critical";

  const latencyColor = {
    fast:     "#48bb78",
    normal:   "#68d391",
    slow:     "#ecc94b",
    critical: "#fc8181",
    unknown:  "#4a5568",
  }[latencyLevel];

  return (
    <div style={lc.card}>
      <div style={lc.top}>
        <span style={lc.name}>{name}</span>
        <span style={lc.dot(isUp)} />
      </div>
      <div style={{ ...lc.latency, color: latencyColor }}>
        {latency != null ? `${latency}` : "—"}
        {latency != null && <span style={lc.unit}>ms</span>}
      </div>
      <div style={lc.meta}>
        Avg 24 h: {avg != null ? `${avg} ms` : "—"}
      </div>
      <div style={lc.level(latencyLevel)}>
        {latencyLevel === "unknown" ? "No data" : latencyLevel.toUpperCase()}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function uptimeColor(pct) {
  if (pct == null) return "#4a5568";
  if (pct >= 99.9) return "#48bb78";
  if (pct >= 99)   return "#68d391";
  if (pct >= 95)   return "#ecc94b";
  return "#fc8181";
}

// ── Styles ────────────────────────────────────────────────────────────────────
const HERO_BG = {
  operational: { bg: "linear-gradient(135deg, #1a3a2a 0%, #0f1117 100%)", border: "#22543d" },
  degraded:    { bg: "linear-gradient(135deg, #3a3010 0%, #0f1117 100%)", border: "#744210" },
  down:        { bg: "linear-gradient(135deg, #3a1010 0%, #0f1117 100%)", border: "#742a2a" },
  loading:     { bg: "linear-gradient(135deg, #1a202c 0%, #0f1117 100%)", border: "#2d3748" },
  error:       { bg: "linear-gradient(135deg, #2d1515 0%, #0f1117 100%)", border: "#742a2a" },
};
const HERO_ICON_COLOR = {
  operational: "#48bb78",
  degraded:    "#ecc94b",
  down:        "#fc8181",
  loading:     "#4a5568",
  error:       "#fc8181",
};

const s = {
  page: {
    minHeight: "100vh",
    background: "#0f1117",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  // Topbar
  topbar: {
    background: "#0a0d14",
    borderBottom: "1px solid #1e2535",
    position: "sticky",
    top: 0,
    zIndex: 100,
  },
  topbarInner: {
    maxWidth: "960px",
    margin: "0 auto",
    padding: "0 24px",
    height: "56px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    textDecoration: "none",
  },
  brandIcon: { fontSize: "20px" },
  brandName: { fontSize: "16px", fontWeight: 800, color: "#4FD1C5", letterSpacing: "-0.02em" },
  dashLink: {
    fontSize: "13px",
    color: "#4FD1C5",
    textDecoration: "none",
    padding: "6px 14px",
    border: "1px solid #1e2535",
    borderRadius: "8px",
    transition: "border-color 0.15s",
  },

  // Hero
  hero: (status) => ({
    background: (HERO_BG[status] || HERO_BG.loading).bg,
    borderBottom: `1px solid ${(HERO_BG[status] || HERO_BG.loading).border}`,
    padding: "48px 24px",
  }),
  heroInner: {
    maxWidth: "960px",
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    gap: "20px",
  },
  heroIcon: (status) => ({
    width: 52,
    height: 52,
    borderRadius: "50%",
    background: `${HERO_ICON_COLOR[status] || "#4a5568"}22`,
    border: `2px solid ${HERO_ICON_COLOR[status] || "#4a5568"}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "22px",
    fontWeight: 800,
    color: HERO_ICON_COLOR[status] || "#4a5568",
    flexShrink: 0,
  }),
  heroTitle: {
    fontSize: "24px",
    fontWeight: 800,
    color: "#e2e8f0",
    margin: 0,
    letterSpacing: "-0.02em",
  },
  heroSub: { fontSize: "13px", color: "#4a5568", marginTop: "4px" },

  // Container
  container: {
    maxWidth: "960px",
    margin: "0 auto",
    padding: "40px 24px",
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "48px",
  },
  section: {},
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    marginBottom: "16px",
    paddingBottom: "10px",
    borderBottom: "1px solid #1e2535",
  },
  sectionTitle: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#a0aec0",
    margin: 0,
    letterSpacing: "0.02em",
  },
  sectionMeta: { fontSize: "12px", color: "#3d4a5c" },
  serviceList: { display: "flex", flexDirection: "column", gap: "2px" },

  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: "12px",
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "12px",
  },

  placeholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "64px 0",
    color: "#4a5568",
    fontSize: "14px",
  },
  spinner: {
    width: 20, height: 20,
    border: "2px solid #2d3748",
    borderTopColor: "#4FD1C5",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  errorBox: {
    display: "flex",
    alignItems: "flex-start",
    gap: "14px",
    background: "#742a2a22",
    border: "1px solid #742a2a",
    borderRadius: "10px",
    padding: "18px 20px",
    color: "#fc8181",
    fontSize: "14px",
  },

  // Footer
  footer: {
    background: "#0a0d14",
    borderTop: "1px solid #1e2535",
    padding: "16px 24px",
  },
  footerInner: {
    maxWidth: "960px",
    margin: "0 auto",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    fontSize: "12px",
    color: "#3d4a5c",
  },
  footerRight: { color: "#2d3748" },
};

// Service Row styles
const sr = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "16px",
    padding: "18px 20px",
    background: "#13171f",
    border: "1px solid #1e2535",
    borderRadius: "10px",
    marginBottom: "4px",
    transition: "border-color 0.15s",
  },
  left: { display: "flex", alignItems: "center", gap: "12px", minWidth: "180px" },
  dot: (isUp) => ({
    width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
    background: isUp ? "#48bb78" : "#fc8181",
    boxShadow: `0 0 6px ${isUp ? "#48bb78" : "#fc8181"}`,
  }),
  name: { fontSize: "14px", fontWeight: 600, color: "#e2e8f0" },
  url:  { fontSize: "11px", color: "#3d4a5c", fontFamily: "monospace", textDecoration: "none", display: "block", marginTop: "2px" },
  barWrap: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: "2px",
    minWidth: "200px",
    maxWidth: "400px",
  },
  bar: (state) => ({
    flex: 1,
    height: "28px",
    borderRadius: "2px",
    background: barColor(state),
    opacity: state === "up" ? 0.7 : 1,
    minWidth: "2px",
    cursor: "default",
  }),
  barLabel: { fontSize: "10px", color: "#2d3748", whiteSpace: "nowrap", paddingLeft: "6px" },
  right: { display: "flex", alignItems: "center", gap: "12px" },
  uptime: (pct) => ({
    fontSize: "14px",
    fontWeight: 700,
    color: uptimeColor(pct),
    minWidth: "52px",
    textAlign: "right",
  }),
  badge: (isUp) => ({
    padding: "3px 10px",
    borderRadius: "20px",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.07em",
    background: isUp ? "#22543d" : "#742a2a",
    color:      isUp ? "#68d391"  : "#fc8181",
    flexShrink: 0,
  }),
};

// Uptime Card styles
const uc = {
  card: {
    background: "#13171f",
    border: "1px solid #1e2535",
    borderRadius: "10px",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  cardName: { fontSize: "13px", fontWeight: 700, color: "#c8d0e0" },
  row: { display: "flex", alignItems: "center", gap: "10px" },
  label: { fontSize: "10px", color: "#4a5568", width: "24px", flexShrink: 0 },
  pct:   { fontSize: "12px", fontWeight: 700, width: "44px", textAlign: "right", flexShrink: 0 },
};

// ── Incident Row ──────────────────────────────────────────────────────────────
function IncidentRow({ inc }) {
  const name      = inc.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const startTime = new Date(inc.startedAt);
  const isOngoing = inc.ongoing === true;

  // Format duration: "2h 14m" or "45s"
  function fmtDuration(ms) {
    if (!ms) return "—";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  const duration = isOngoing
    ? fmtDuration(Date.now() - inc.startedAt) + " (ongoing)"
    : fmtDuration(inc.durationMs);

  return (
    <div style={ih.row(isOngoing)}>
      <div style={ih.rowLeft}>
        <span style={ih.statusDot(isOngoing)} />
        <div>
          <div style={ih.serviceName}>{name}</div>
          <a href={inc.url} target="_blank" rel="noopener noreferrer" style={ih.serviceUrl}>
            {inc.url}
          </a>
        </div>
      </div>
      <div style={ih.rowMid}>
        <span style={ih.badge(isOngoing)}>
          {isOngoing ? "ONGOING" : "RESOLVED"}
        </span>
      </div>
      <div style={ih.rowRight}>
        <div style={ih.timeLabel}>
          {startTime.toLocaleDateString()} {startTime.toLocaleTimeString()}
        </div>
        <div style={ih.durationLabel}>{duration}</div>
      </div>
    </div>
  );
}

// Incident history styles
const ih = {
  list:  { display: "flex", flexDirection: "column", gap: "4px" },
  empty: {
    display: "flex", alignItems: "center", gap: "10px",
    padding: "24px 20px",
    background: "#13171f", border: "1px solid #1e2535",
    borderRadius: "10px", fontSize: "13px", color: "#4a5568",
  },
  emptyIcon: { fontSize: "16px", color: "#48bb78" },
  row: (ongoing) => ({
    display: "flex", alignItems: "center",
    justifyContent: "space-between", flexWrap: "wrap",
    gap: "12px", padding: "14px 20px",
    background: "#13171f",
    border: `1px solid ${ongoing ? "#742a2a" : "#1e2535"}`,
    borderRadius: "10px",
    transition: "border-color 0.15s",
  }),
  rowLeft: { display: "flex", alignItems: "center", gap: "12px", minWidth: "180px" },
  statusDot: (ongoing) => ({
    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
    background: ongoing ? "#fc8181" : "#4a5568",
    boxShadow: ongoing ? "0 0 6px #fc8181" : "none",
  }),
  serviceName: { fontSize: "13px", fontWeight: 600, color: "#c8d0e0" },
  serviceUrl:  { fontSize: "11px", color: "#3d4a5c", fontFamily: "monospace", textDecoration: "none", display: "block", marginTop: "2px" },
  rowMid:  { display: "flex", alignItems: "center" },
  badge: (ongoing) => ({
    fontSize: "9px", fontWeight: 700, letterSpacing: "0.08em",
    padding: "3px 8px", borderRadius: "20px",
    background: ongoing ? "#742a2a" : "#1e2535",
    color:      ongoing ? "#fc8181" : "#4a5568",
  }),
  rowRight: { textAlign: "right" },
  timeLabel:     { fontSize: "12px", color: "#5a6478" },
  durationLabel: { fontSize: "11px", color: "#3d4a5c", marginTop: "2px" },
};

// Latency Card styles
const lc = {
  card: {
    background: "#13171f",
    border: "1px solid #1e2535",
    borderRadius: "10px",
    padding: "18px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  top: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  name: { fontSize: "12px", fontWeight: 700, color: "#a0aec0" },
  dot: (isUp) => ({
    width: 7, height: 7, borderRadius: "50%",
    background: isUp ? "#48bb78" : "#fc8181",
    boxShadow: `0 0 4px ${isUp ? "#48bb78" : "#fc8181"}`,
  }),
  latency: { fontSize: "32px", fontWeight: 800, lineHeight: 1.1 },
  unit:    { fontSize: "14px", fontWeight: 400, marginLeft: "2px", opacity: 0.7 },
  meta:    { fontSize: "11px", color: "#4a5568" },
  level: (level) => ({
    display: "inline-block",
    fontSize: "9px",
    fontWeight: 700,
    letterSpacing: "0.09em",
    padding: "2px 7px",
    borderRadius: "4px",
    alignSelf: "flex-start",
    marginTop: "4px",
    background: level === "fast"     ? "#22543d"
              : level === "normal"   ? "#22543d"
              : level === "slow"     ? "#744210"
              : level === "critical" ? "#742a2a"
              : "#1e2535",
    color: level === "fast"     ? "#68d391"
         : level === "normal"   ? "#68d391"
         : level === "slow"     ? "#ecc94b"
         : level === "critical" ? "#fc8181"
         : "#4a5568",
  }),
};
