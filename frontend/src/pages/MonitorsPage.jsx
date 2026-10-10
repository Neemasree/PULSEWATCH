import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../api";

export default function MonitorsPage() {
  const [monitors, setMonitors] = useState([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name: "", url: "", interval_seconds: 60, expected_status: 200 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() { try { setMonitors((await api.monitors()).monitors || []); } catch (e) { setError(e.message); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault(); setError("");
    try { await api.createMonitor(form); setForm({ name: "", url: "", interval_seconds: 60, expected_status: 200 }); load(); }
    catch (e) { setError(e.message); }
  }
  async function toggle(m) {
    try { await (m.enabled ? api.pauseMonitor(m.id) : api.resumeMonitor(m.id)); load(); }
    catch (e) { setError(e.message); }
  }
  async function remove(m) {
    if (!window.confirm(`Delete ${m.name}?`)) return;
    try { await api.deleteMonitor(m.id); load(); } catch (e) { setError(e.message); }
  }
  const visible = monitors.filter((m) => `${m.name} ${m.url}`.toLowerCase().includes(search.toLowerCase()));
  return <AppShell connected>
    <h1 style={s.h1}>Monitors</h1>
    <p style={s.sub}>Manage endpoints, thresholds and public visibility.</p>
    <form onSubmit={add} style={s.form}>
      {["name", "url"].map((key) => <input key={key} required style={s.input} placeholder={key} type={key === "url" ? "url" : "text"} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />)}
      <button style={s.button}>Add monitor</button>
    </form>
    <input style={{ ...s.input, width: "100%", maxWidth: 420, marginBottom: 14 }} placeholder="Search monitors" value={search} onChange={(e) => setSearch(e.target.value)} />
    {error && <div style={s.error}>{error}</div>}
    {loading ? <div style={s.empty}>Loading monitors…</div> : !visible.length ? <div style={s.empty}>No monitors found.</div> :
      <div style={s.table}>{visible.map((m) => <div key={m.id} style={s.row}>
        <Link style={s.link} to={`/monitors/${m.id}`}><strong>{m.name}</strong><span>{m.url}</span></Link>
        <span style={{ color: m.enabled ? "#68d391" : "#718096" }}>{m.enabled ? "Enabled" : "Paused"}</span>
        <button style={s.small} onClick={() => toggle(m)}>{m.enabled ? "Pause" : "Resume"}</button>
        <button style={s.danger} onClick={() => remove(m)}>Delete</button>
      </div>)}</div>}
  </AppShell>;
}
const s = {
  h1: { color: "#e2e8f0", margin: 0 }, sub: { color: "#718096", fontSize: 13 },
  form: { display: "flex", gap: 8, flexWrap: "wrap", margin: "22px 0 14px" },
  input: { background: "#0f1117", border: "1px solid #2d3748", borderRadius: 7, padding: "9px 11px", color: "#e2e8f0" },
  button: { background: "#4FD1C5", border: 0, borderRadius: 7, padding: "9px 15px", fontWeight: 700 },
  table: { border: "1px solid #1e2535", borderRadius: 8 }, row: { display: "flex", alignItems: "center", gap: 14, padding: 14, borderBottom: "1px solid #1e2535" },
  link: { display: "flex", flexDirection: "column", gap: 4, color: "#e2e8f0", textDecoration: "none", flex: 1 }, small: { background: "#1e2535", color: "#c8d0e0", border: 0, borderRadius: 5, padding: "6px 10px" },
  danger: { background: "transparent", color: "#fc8181", border: 0 }, error: { color: "#fc8181", marginBottom: 12 }, empty: { color: "#718096", padding: 40, textAlign: "center" },
};
