/**
 * LatencyChart.jsx
 * Line chart showing response-time history for a single endpoint.
 *
 * Features:
 *   - 1h / 6h / 24h range selector — filters the results array by timestamp
 *   - Real time-axis labels (HH:MM format, max 6 ticks so they don't crowd)
 *   - Anomaly points rendered in red with larger radius
 *   - "No data in range" state when the selected window is empty
 */

import React, { useMemo, useState } from "react";
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Tooltip, Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

// Range definitions — label shown in the toggle + how many ms back to include
const RANGES = [
  { label: "1h",  ms: 60 * 60 * 1000 },
  { label: "6h",  ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
];

function makeOptions(range) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 180 },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: ([ctx]) => {
            // Full timestamp in tooltip title
            const r = ctx.dataset.rawResults?.[ctx.dataIndex];
            return r ? new Date(r.timestamp).toLocaleTimeString() : ctx.label;
          },
          label: (ctx) => ` ${ctx.parsed.y}ms`,
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: "#4a5568",
          maxTicksLimit: 6,
          maxRotation: 0,
        },
        grid: { color: "#1a202c" },
      },
      y: {
        ticks: { color: "#4a5568", callback: (v) => `${v}ms` },
        grid:  { color: "#1a202c" },
        beginAtZero: true,
      },
    },
  };
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function LatencyChart({ results }) {
  const [rangeIdx, setRangeIdx] = useState(0); // default: 1h
  const range = RANGES[rangeIdx];

  // Filter results to the selected time window, then sort oldest→newest
  const filtered = useMemo(() => {
    const cutoff = Date.now() - range.ms;
    return [...results]
      .filter((r) => new Date(r.timestamp).getTime() >= cutoff)
      .reverse(); // results come in newest-first, chart needs oldest-first
  }, [results, range.ms]);

  const hasData = filtered.length > 0;

  const chartData = useMemo(() => ({
    labels: filtered.map((r) => fmtTime(r.timestamp)),
    datasets: [{
      data:            filtered.map((r) => r.responseTime),
      rawResults:      filtered, // passed through for tooltip title
      borderColor:     "#4FD1C5",
      backgroundColor: "rgba(79,209,197,0.07)",
      fill:            true,
      tension:         0.35,
      pointBackgroundColor: filtered.map((r) => r.anomaly?.isAnomaly ? "#FC8181" : "#4FD1C5"),
      pointRadius:          filtered.map((r) => r.anomaly?.isAnomaly ? 5 : 2),
      pointHoverRadius: 6,
      borderWidth: 1.5,
    }],
  }), [filtered]);

  return (
    <div>
      {/* Range selector */}
      <div style={st.rangeBar}>
        {RANGES.map((r, i) => (
          <button
            key={r.label}
            onClick={() => setRangeIdx(i)}
            style={st.rangeBtn(i === rangeIdx)}
            aria-pressed={i === rangeIdx}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Chart or empty state */}
      <div style={{ height: "120px", position: "relative" }}>
        {hasData ? (
          <Line data={chartData} options={makeOptions(range)} />
        ) : (
          <div style={st.empty}>No data in the last {range.label}</div>
        )}
      </div>
    </div>
  );
}

const st = {
  rangeBar: {
    display: "flex",
    gap: "4px",
    justifyContent: "flex-end",
    marginBottom: "8px",
  },
  rangeBtn: (active) => ({
    background:  active ? "#1e2535" : "transparent",
    border:      `1px solid ${active ? "#4FD1C5" : "#2d3748"}`,
    borderRadius: "5px",
    color:        active ? "#4FD1C5" : "#4a5568",
    cursor:      "pointer",
    fontSize:    "10px",
    fontWeight:   active ? 700 : 400,
    padding:     "2px 8px",
    transition:  "all 0.15s",
  }),
  empty: {
    position:   "absolute", inset: 0,
    display:    "flex", alignItems: "center", justifyContent: "center",
    fontSize:   "12px", color: "#4a5568",
  },
};
