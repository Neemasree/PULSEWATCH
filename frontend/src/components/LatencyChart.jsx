import React, { useMemo } from "react";
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Tooltip, Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

const OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 180 },
  plugins: {
    legend: { display: false },
    tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.y}ms` } },
  },
  scales: {
    x: { ticks: { color: "#4a5568", maxTicksLimit: 5, maxRotation: 0 }, grid: { color: "#1a202c" } },
    y: { ticks: { color: "#4a5568", callback: (v) => `${v}ms` }, grid: { color: "#1a202c" }, beginAtZero: true },
  },
};

export default function LatencyChart({ results }) {
  const chrono = useMemo(() => [...results].reverse(), [results]);

  const labels = chrono.map((r) => {
    const d = new Date(r.timestamp);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  });

  const data = {
    labels,
    datasets: [{
      data: chrono.map((r) => r.responseTime),
      borderColor: "#4FD1C5",
      backgroundColor: "rgba(79,209,197,0.07)",
      fill: true,
      tension: 0.35,
      pointBackgroundColor: chrono.map((r) => r.anomaly?.isAnomaly ? "#FC8181" : "#4FD1C5"),
      pointRadius:          chrono.map((r) => r.anomaly?.isAnomaly ? 5 : 2),
      pointHoverRadius: 6,
      borderWidth: 1.5,
    }],
  };

  return <div style={{ height: "120px" }}><Line data={data} options={OPTIONS} /></div>;
}
