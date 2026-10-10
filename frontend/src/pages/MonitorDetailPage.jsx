import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import LatencyChart from "../components/LatencyChart";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../hooks/useSocket";

export default function MonitorDetailPage() {
  const { id } = useParams(); const { user } = useAuth(); const { monitorData } = useSocket(user);
  const [monitor, setMonitor] = useState(null); const [stats, setStats] = useState(null); const [incidents, setIncidents] = useState([]); const [range, setRange] = useState("24h"); const [error, setError] = useState("");
  useEffect(() => { Promise.all([api.monitor(id), api.monitorStats(id, range), api.monitorIncidents(id)]).then(([m, s, i]) => { setMonitor(m.monitor); setStats(s); setIncidents(i.incidents || []); }).catch((e) => setError(e.message)); }, [id, range]);
  if (error) return <AppShell connected><div style={s.error}>{error}</div></AppShell>;
  if (!monitor) return <AppShell connected><div style={s.empty}>Loading monitor…</div></AppShell>;
  const results = monitorData[id] || [];
  return <AppShell connected><Link to="/monitors" style={s.back}>← Monitors</Link><h1 style={s.h1}>{monitor.name}</h1><p style={s.sub}>{monitor.url}</p>
    <div style={s.ranges}>{["24h", "7d", "30d", "90d"].map((r) => <button key={r} onClick={() => setRange(r)} style={range === r ? s.active : s.range}>{r}</button>)}</div>
    <div style={s.cards}>{[["Uptime", stats?.uptimePct == null ? "—" : `${stats.uptimePct}%`], ["Avg latency", stats?.avgLatencyMs == null ? "—" : `${stats.avgLatencyMs}ms`], ["Incidents", stats?.incidentCount ?? "—"], ["Status", stats?.currentStatus || "unknown"]].map(([label, value]) => <div style={s.card} key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    <section style={s.panel}><h2>Latency</h2><LatencyChart results={results} /></section>
    <section style={s.panel}><h2>Incidents</h2>{incidents.length ? incidents.map((i) => <div style={s.incident} key={i.id}><span>{i.status}</span><span>{new Date(i.started_at).toLocaleString()}</span></div>) : <div style={s.empty}>No incidents.</div>}</section>
    <a href={api.exportMonitor(id, range)} style={s.download}>Download checks CSV</a> <a href={api.reportMonitor(id)} style={s.download}>Download report CSV</a>
  </AppShell>;
}
const s = { h1: { color: "#e2e8f0", marginBottom: 3 }, sub: { color: "#718096" }, back: { color: "#4FD1C5" }, ranges: { display: "flex", gap: 5, margin: "20px 0" }, range: { background: "transparent", color: "#718096", border: "1px solid #2d3748", padding: "6px 10px" }, active: { background: "#1e2535", color: "#4FD1C5", border: "1px solid #4FD1C5", padding: "6px 10px" }, cards: { display: "flex", gap: 10, flexWrap: "wrap" }, card: { background: "#0f1420", border: "1px solid #1e2535", borderRadius: 8, padding: 16, minWidth: 130 }, cardSmall: {}, panel: { background: "#0f1420", border: "1px solid #1e2535", borderRadius: 8, padding: 16, marginTop: 18 }, incident: { display: "flex", justifyContent: "space-between", padding: 10, borderBottom: "1px solid #1e2535" }, download: { color: "#4FD1C5", marginRight: 14 }, error: { color: "#fc8181" }, empty: { color: "#718096", padding: 30, textAlign: "center" } };
