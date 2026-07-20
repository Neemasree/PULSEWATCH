import React from "react";

export default function PollingStats({ stats }) {
  if (!stats) return null;
  const saved    = stats.fixedTotalChecks - stats.totalAdaptiveChecks;
  const savedPct = stats.savedPct ?? 0;

  return (
    <div style={s.panel}>
      <Metric label="Adaptive checks"    value={stats.totalAdaptiveChecks.toLocaleString()} accent="#4FD1C5" />
      <Metric label="Fixed-10s equiv."   value={stats.fixedTotalChecks.toLocaleString()} />
      <Metric
        label="Checks saved"
        value={`${saved > 0 ? saved.toLocaleString() : 0}`}
        sub={`${savedPct}% reduction`}
        accent="#68d391"
      />
      <div style={s.intervals}>
        <div style={s.intLabel}>Current intervals</div>
        <div style={s.intRow}>
          {Object.entries(stats.urlIntervals || {}).map(([url, ms]) => {
            const host  = url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
            const color = ms <= 5000 ? "#fc8181" : ms >= 55000 ? "#68d391" : "#718096";
            return (
              <span key={url} title={url} style={{ ...s.chip, color, borderColor: color + "55" }}>
                {host} <strong>{(ms / 1000).toFixed(0)}s</strong>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent }) {
  return (
    <div>
      <div style={s.metricLabel}>{label}</div>
      <div style={{ ...s.metricValue, ...(accent ? { color: accent } : {}) }}>{value}</div>
      {sub && <div style={s.metricSub}>{sub}</div>}
    </div>
  );
}

const s = {
  panel: {
    background: "#1a202c",
    border: "1px solid #2d3748",
    borderRadius: "12px",
    padding: "20px 24px",
    display: "flex",
    flexWrap: "wrap",
    gap: "28px",
    alignItems: "flex-start",
  },
  metricLabel: { fontSize: "11px", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "3px" },
  metricValue: { fontSize: "26px", fontWeight: 800, color: "#e2e8f0" },
  metricSub:   { fontSize: "12px", color: "#68d391", fontWeight: 600, marginTop: "1px" },
  intervals:   { display: "flex", flexDirection: "column", gap: "6px" },
  intLabel:    { fontSize: "11px", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.07em" },
  intRow:      { display: "flex", flexWrap: "wrap", gap: "6px" },
  chip: {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "5px",
    border: "1px solid",
    background: "#0f1117",
    fontFamily: "monospace",
  },
};
