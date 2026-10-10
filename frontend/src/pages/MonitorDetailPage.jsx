import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import LatencyChart from "../components/LatencyChart";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../hooks/useSocket";

export default function MonitorDetailPage() {
  const { id } = useParams(); const { user } = useAuth(); const { monitorData } = useSocket(user);
  const [monitor, setMonitor] = useState(null); const [stats, setStats] = useState(null); const [incidents, setIncidents] = useState([]); const [windows, setWindows] = useState([]); const [range, setRange] = useState("24h"); const [maintenanceForm, setMaintenanceForm] = useState({ starts_at: "", ends_at: "", reason: "" }); const [error, setError] = useState("");
  useEffect(() => { Promise.all([api.monitor(id), api.monitorStats(id, range), api.monitorIncidents(id), api.maintenance(id)]).then(([m, s, i, w]) => { setMonitor(m.monitor); setStats(s); setIncidents(i.incidents || []); setWindows(w.windows || []); }).catch((e) => setError(e.message)); }, [id, range]);
  async function acknowledge(incidentId) {
    try {
      const response = await api.acknowledgeIncident(incidentId);
      setIncidents((current) => current.map((incident) => incident.id === incidentId ? response.incident : incident));
    } catch (e) { setError(e.message); }
  }
  async function removeWindow(windowId) {
    try { await api.deleteMaintenance(windowId); setWindows((current) => current.filter((item) => item.id !== windowId)); }
    catch (e) { setError(e.message); }
  }
  async function addWindow(event) {
    event.preventDefault();
    setError("");
    try {
      const response = await api.createMaintenance(id, {
        starts_at: new Date(maintenanceForm.starts_at).toISOString(),
        ends_at: new Date(maintenanceForm.ends_at).toISOString(),
        reason: maintenanceForm.reason || undefined,
      });
      setWindows((current) => [...current, response.window].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)));
      setMaintenanceForm({ starts_at: "", ends_at: "", reason: "" });
    } catch (e) { setError(e.message); }
  }
  if (error) return <AppShell connected><div style={s.error}>{error}</div></AppShell>;
  if (!monitor) return <AppShell connected><div style={s.empty}>Loading monitor…</div></AppShell>;
  const results = monitorData[id] || [];
  return <AppShell connected><Link to="/monitors" style={s.back}>← Monitors</Link><h1 style={s.h1}>{monitor.name}</h1><p style={s.sub}>{monitor.url}</p>
    <div style={s.ranges}>{["24h", "7d", "30d", "90d"].map((r) => <button key={r} onClick={() => setRange(r)} style={range === r ? s.active : s.range}>{r}</button>)}</div>
    <div style={s.cards}>{[["Uptime", stats?.uptimePct == null ? "—" : `${stats.uptimePct}%`], ["Avg latency", stats?.avgLatencyMs == null ? "—" : `${stats.avgLatencyMs}ms`], ["Incidents", stats?.incidentCount ?? "—"], ["Status", stats?.currentStatus || "unknown"]].map(([label, value]) => <div style={s.card} key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    <section style={s.panel}><h2>Latency</h2><LatencyChart results={results} /></section>
    <section style={s.panel}><h2>Incidents</h2>{incidents.length ? incidents.map((i) => <div style={s.incident} key={i.id}><span>{i.status}</span><span>{new Date(i.started_at).toLocaleString()}</span>{i.status === "OPEN" && <button style={s.small} onClick={() => acknowledge(i.id)}>Acknowledge</button>}</div>) : <div style={s.empty}>No incidents.</div>}</section>
    <section style={s.panel}><h2>Maintenance windows</h2><form onSubmit={addWindow} style={s.maintenanceForm}><input required type="datetime-local" style={s.input} value={maintenanceForm.starts_at} onChange={(e) => setMaintenanceForm({ ...maintenanceForm, starts_at: e.target.value })} /><input required type="datetime-local" style={s.input} value={maintenanceForm.ends_at} onChange={(e) => setMaintenanceForm({ ...maintenanceForm, ends_at: e.target.value })} /><input style={s.input} placeholder="Reason (optional)" value={maintenanceForm.reason} onChange={(e) => setMaintenanceForm({ ...maintenanceForm, reason: e.target.value })} /><button style={s.small}>Schedule</button></form>{windows.length ? windows.map((window) => <div style={s.incident} key={window.id}><span>{window.reason || "Scheduled maintenance"}</span><span>{new Date(window.starts_at).toLocaleString()} – {new Date(window.ends_at).toLocaleString()}</span><button style={s.small} onClick={() => removeWindow(window.id)}>Remove</button></div>) : <div style={s.empty}>No maintenance windows.</div>}</section>
    <a href={api.exportMonitor(id, range)} style={s.download}>Download checks CSV</a> <a href={api.reportMonitor(id)} style={s.download}>Download report CSV</a>
  </AppShell>;
}
const s = { h1: { color: "#e2e8f0", marginBottom: 3 }, sub: { color: "#718096" }, back: { color: "#4FD1C5" }, ranges: { display: "flex", gap: 5, margin: "20px 0" }, range: { background: "transparent", color: "#718096", border: "1px solid #2d3748", padding: "6px 10px" }, active: { background: "#1e2535", color: "#4FD1C5", border: "1px solid #4FD1C5", padding: "6px 10px" }, cards: { display: "flex", gap: 10, flexWrap: "wrap" }, card: { background: "#0f1420", border: "1px solid #1e2535", borderRadius: 8, padding: 16, minWidth: 130 }, panel: { background: "#0f1420", border: "1px solid #1e2535", borderRadius: 8, padding: 16, marginTop: 18 }, incident: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 10, borderBottom: "1px solid #1e2535" }, maintenanceForm: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }, input: { background: "#0f1117", border: "1px solid #2d3748", borderRadius: 7, padding: "8px 10px", color: "#e2e8f0" }, small: { background: "#1e2535", color: "#c8d0e0", border: 0, borderRadius: 5, padding: "6px 10px" }, download: { color: "#4FD1C5", marginRight: 14 }, error: { color: "#fc8181" }, empty: { color: "#718096", padding: 30, textAlign: "center" } };
