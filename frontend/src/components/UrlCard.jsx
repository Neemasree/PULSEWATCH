import React, { useState } from "react";
import LatencyChart from "./LatencyChart";

function UptimePip({ status }) {
  const color = status === "up" ? "#68d391" : "#fc8181";
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: color, boxShadow: `0 0 5px ${color}`, flexShrink: 0,
    }} />
  );
}

export default function UrlCard({ url, results, onRemove, canRemove }) {
  const [removing, setRemoving] = useState(false);

  if (!results || results.length === 0) {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <UptimePip status="unknown" />
          <span style={s.url} title={url}>{url}</span>
        </div>
        <div style={s.waiting}>Waiting for first check…</div>
      </div>
    );
  }

  const latest     = results[0];
  const isAnomaly  = latest.anomaly?.isAnomaly;
  const avgLatency = Math.round(results.reduce((a, r) => a + (r.responseTime || 0), 0) / results.length);
  const p95        = (() => {
    const sorted = [...results].map((r) => r.responseTime).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  })();

  const elapsed = Date.now() - new Date(latest.timestamp).getTime();
  const ago     = elapsed < 60000 ? `${Math.round(elapsed / 1000)}s ago` : `${Math.round(elapsed / 60000)}m ago`;

  async function handleRemove() {
    if (!onRemove) return;
    setRemoving(true);
    try { await onRemove(url); } finally { setRemoving(false); }
  }

  return (
    <div style={isAnomaly ? { ...s.card, ...s.cardAlert } : s.card}>
      {/* Header */}
      <div style={s.header}>
        <UptimePip status={latest.status} />
        <span style={s.url} title={url}>{url.replace(/^https?:\/\/(www\.)?/, "")}</span>
        <span style={s.badge(latest.status)}>{latest.status.toUpperCase()}</span>
        {canRemove && (
          <button
            onClick={handleRemove}
            disabled={removing}
            style={s.removeBtn}
            title="Stop monitoring this URL"
            aria-label={`Remove ${url}`}
          >
            {removing ? "…" : "✕"}
          </button>
        )}
      </div>

      {/* Anomaly banner */}
      {isAnomaly && (
        <div style={s.anomalyBanner} role="alert">
          ⚠ Anomaly — z-score {latest.anomaly.zScore}σ (baseline: {latest.anomaly.mean}ms ± {latest.anomaly.stdDev}ms)
        </div>
      )}

      {/* Stats row */}
      <div style={s.stats}>
        <Stat label="Latency" value={`${latest.responseTime}ms`} accent={latest.responseTime > 1000 ? "#fc8181" : "#68d391"} />
        <Stat label="Avg"     value={`${avgLatency}ms`} />
        <Stat label="p95"     value={`${p95}ms`} />
        {isAnomaly && <Stat label="Z-score" value={latest.anomaly.zScore} accent="#fc8181" />}
        <Stat label="Checked" value={ago} small />
      </div>

      {/* Chart */}
      <LatencyChart results={results} />
    </div>
  );
}

function Stat({ label, value, accent, small }) {
  return (
    <div style={s.stat}>
      <span style={s.statLabel}>{label}</span>
      <span style={{ ...s.statValue, ...(small ? s.statSmall : {}), ...(accent ? { color: accent } : {}) }}>
        {value}
      </span>
    </div>
  );
}

const s = {
  card: {
    background: "#1a202c",
    border: "1px solid #2d3748",
    borderRadius: "12px",
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  cardAlert: {
    borderColor: "#FC8181",
    boxShadow: "0 0 0 1px #FC818133, 0 4px 24px #FC818122",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  url: {
    flex: 1,
    fontSize: "13px",
    fontFamily: "monospace",
    color: "#a0aec0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  badge: (status) => ({
    flexShrink: 0,
    padding: "2px 9px",
    borderRadius: "20px",
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    background: status === "up" ? "#22543d" : "#742a2a",
    color:      status === "up" ? "#68d391"  : "#fc8181",
  }),
  removeBtn: {
    flexShrink: 0,
    background: "none",
    border: "1px solid #4a5568",
    borderRadius: "4px",
    color: "#718096",
    cursor: "pointer",
    fontSize: "11px",
    padding: "2px 6px",
    lineHeight: 1,
  },
  anomalyBanner: {
    background: "#742a2a33",
    border: "1px solid #742a2a",
    borderRadius: "6px",
    padding: "7px 10px",
    fontSize: "11px",
    color: "#fc8181",
    fontWeight: 500,
  },
  stats: { display: "flex", gap: "20px", flexWrap: "wrap" },
  stat:  { display: "flex", flexDirection: "column", gap: "2px" },
  statLabel: { fontSize: "10px", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.07em" },
  statValue: { fontSize: "18px", fontWeight: 700, color: "#e2e8f0" },
  statSmall: { fontSize: "13px", paddingTop: "2px" },
  waiting:   { fontSize: "13px", color: "#4a5568", textAlign: "center", padding: "16px 0" },
};
