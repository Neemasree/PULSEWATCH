/**
 * StatusPage.jsx
 * Public status page — no authentication required.
 * Shows current up/down status + 24 h and 7 d uptime % per service.
 * Polls /api/public/status every 30 s.
 *
 * This is the page you'd share as "status.yourcompany.com".
 * Same backend data, different view — no extra backend work needed.
 */

import React, { useEffect, useState } from "react";
import { api } from "../api";

const REFRESH_MS = 30_000;

export default function StatusPage() {
  const [data,    setData]    = useState(null);
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(true);

  async function fetchStatus() {
    try {
      const res = await api.publicStatus();
      setData(res);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const allUp = data?.services?.every((s) => s.currentStatus === "up");

  return (
    <div style={s.page}>
      <div style={s.container}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.logoIcon}>⚡</span>
          <div>
            <h1 style={s.h1}>PulseWatch Status</h1>
            <p style={s.tagline}>Real-time service health &amp; uptime</p>
          </div>
          <a href="/login" style={s.loginLink}>Dashboard →</a>
        </div>

        {/* Overall banner */}
        {!loading && !error && (
          <div style={s.banner(allUp)}>
            <span style={s.bannerDot(allUp)} />
            {allUp ? "All systems operational" : "One or more systems degraded"}
          </div>
        )}

        {loading && <div style={s.msg}>Loading…</div>}
        {error   && <div style={{ ...s.msg, color: "#fc8181" }}>Error: {error}</div>}

        {/* Service rows */}
        {data?.services?.map((svc) => (
          <ServiceRow key={svc.url} svc={svc} />
        ))}

        {/* Footer */}
        {data && (
          <div style={s.footer}>
            Last updated: {new Date(data.generatedAt).toLocaleTimeString()}
            &ensp;·&ensp;Refreshes every 30 s
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceRow({ svc }) {
  const isUp     = svc.currentStatus === "up";
  const name     = svc.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];

  return (
    <div style={s.row}>
      <div style={s.rowLeft}>
        <span style={s.rowDot(isUp)} />
        <div>
          <div style={s.rowName}>{name}</div>
          <div style={s.rowUrl}>{svc.url}</div>
        </div>
      </div>

      <div style={s.rowRight}>
        {/* Latency */}
        <Metric
          label="Latency"
          value={svc.latency != null ? `${svc.latency}ms` : "—"}
          color={svc.latency > 1000 ? "#fc8181" : "#68d391"}
        />
        {/* 24 h uptime */}
        <Metric
          label="24 h uptime"
          value={svc.uptime24h != null ? `${svc.uptime24h}%` : "—"}
          color={uptimeColor(svc.uptime24h)}
        />
        {/* 7 d uptime */}
        <Metric
          label="7 d uptime"
          value={svc.uptime7d != null ? `${svc.uptime7d}%` : "—"}
          color={uptimeColor(svc.uptime7d)}
        />
        {/* Avg latency */}
        <Metric
          label="Avg latency"
          value={svc.avgLatency24h != null ? `${svc.avgLatency24h}ms` : "—"}
        />

        {/* Status badge */}
        <span style={s.badge(isUp)}>{svc.currentStatus.toUpperCase()}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, color }) {
  return (
    <div style={s.metric}>
      <div style={s.metricLabel}>{label}</div>
      <div style={{ ...s.metricValue, ...(color ? { color } : {}) }}>{value}</div>
    </div>
  );
}

function uptimeColor(pct) {
  if (pct == null) return "#4a5568";
  if (pct >= 99)   return "#68d391";
  if (pct >= 95)   return "#ecc94b";
  return "#fc8181";
}

const s = {
  page: {
    minHeight: "100vh",
    background: "#0f1117",
    padding: "32px 16px",
  },
  container: {
    maxWidth: "860px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "28px",
  },
  logoIcon: { fontSize: "32px" },
  h1:       { fontSize: "22px", fontWeight: 800, color: "#e2e8f0", margin: 0 },
  tagline:  { fontSize: "13px", color: "#4a5568", marginTop: "2px" },
  loginLink:{
    marginLeft: "auto",
    fontSize: "13px",
    color: "#4FD1C5",
    textDecoration: "none",
    flexShrink: 0,
  },
  banner: (allUp) => ({
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "14px 20px",
    borderRadius: "10px",
    marginBottom: "16px",
    background: allUp ? "#22543d33" : "#742a2a33",
    border:     `1px solid ${allUp ? "#22543d" : "#742a2a"}`,
    fontSize: "14px",
    fontWeight: 600,
    color: allUp ? "#68d391" : "#fc8181",
  }),
  bannerDot: (allUp) => ({
    width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
    background: allUp ? "#68d391" : "#fc8181",
    boxShadow: `0 0 6px ${allUp ? "#68d391" : "#fc8181"}`,
  }),
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "12px",
    padding: "16px 20px",
    background: "#1a202c",
    border: "1px solid #2d3748",
    borderRadius: "10px",
    marginBottom: "8px",
  },
  rowLeft: { display: "flex", alignItems: "center", gap: "12px" },
  rowDot: (isUp) => ({
    width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
    background: isUp ? "#68d391" : "#fc8181",
    boxShadow:  `0 0 5px ${isUp ? "#68d391" : "#fc8181"}`,
  }),
  rowName: { fontSize: "14px", fontWeight: 600, color: "#e2e8f0" },
  rowUrl:  { fontSize: "11px", color: "#4a5568", fontFamily: "monospace", marginTop: "2px" },
  rowRight: { display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap" },
  metric:      { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  metricLabel: { fontSize: "10px", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.06em" },
  metricValue: { fontSize: "15px", fontWeight: 700, color: "#e2e8f0" },
  badge: (isUp) => ({
    padding: "3px 10px",
    borderRadius: "20px",
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    background: isUp ? "#22543d" : "#742a2a",
    color:      isUp ? "#68d391"  : "#fc8181",
    flexShrink: 0,
  }),
  msg:    { textAlign: "center", padding: "40px", color: "#4a5568", fontSize: "14px" },
  footer: { textAlign: "center", fontSize: "12px", color: "#4a5568", marginTop: "16px" },
};
