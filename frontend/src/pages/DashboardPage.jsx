import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import UrlCard from "../components/UrlCard";
import PollingStats from "../components/PollingStats";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";

export default function DashboardPage() {
  const { user } = useAuth();
  const { monitorData, pollingStats, connected } = useSocket(user);
  const isAdmin = user?.role === "admin";

  const [newUrl,    setNewUrl]    = useState("");
  const [addError,  setAddError]  = useState("");
  const [adding,    setAdding]    = useState(false);
  const [monitors,  setMonitors]  = useState([]);

  // Load monitor list for display names and for delete-by-id
  useEffect(() => {
    api.monitors().then((d) => setMonitors(d.monitors || [])).catch(() => {});
  }, [user?.id]);

  async function handleAddUrl(e) {
    e.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      const url  = newUrl.trim();
      const name = new URL(url).hostname;
      const { monitor } = await api.createMonitor({ name, url, is_public: true });
      setMonitors((prev) => [...prev, monitor]);
      setNewUrl("");
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveMonitor(monitorId) {
    try {
      await api.deleteMonitor(monitorId);
      setMonitors((prev) => prev.filter((m) => m.id !== monitorId));
    } catch (err) { console.error("[Dashboard] Remove failed:", err.message); }
  }

  // Build display list: merge monitors with their latest socket data
  // monitorData is keyed by monitorId (number or string from server)
  const monitorIds = monitors.map((m) => m.id);
  const upCount      = monitorIds.filter((id) => monitorData[id]?.[0]?.status === "up").length;
  const anomalyCount = monitorIds.filter((id) => monitorData[id]?.[0]?.anomaly?.isAnomaly).length;

  const sortedMonitors = [...monitors].sort((a, b) => {
    const aL = monitorData[a.id]?.[0];
    const bL = monitorData[b.id]?.[0];
    const aS = (aL?.anomaly?.isAnomaly ? -2 : 0) + (aL?.status === "down" ? -1 : 0);
    const bS = (bL?.anomaly?.isAnomaly ? -2 : 0) + (bL?.status === "down" ? -1 : 0);
    return aS !== bS ? aS - bS : a.name.localeCompare(b.name);
  });

  return (
    <AppShell connected={connected}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.h1}>Dashboard</h1>
          <p style={s.subtitle}>Live uptime monitoring · adaptive polling · z-score anomaly detection</p>
        </div>
        <div style={s.pills}>
          {monitors.length > 0 && <>
            <Pill label={`${upCount}/${monitors.length}`} sub="online"
              color={upCount === monitors.length ? "#68d391" : "#fc8181"} />
            {anomalyCount > 0 && <Pill label={anomalyCount} sub="anomalies" color="#fc8181" />}
            {pollingStats && <Pill label={`${pollingStats.savedPct}%`} sub="checks saved" color="#4FD1C5" />}
          </>}
        </div>
      </div>

      {pollingStats && (
        <section style={s.section}>
          <SectionTitle>Adaptive Polling</SectionTitle>
          <PollingStats stats={pollingStats} />
        </section>
      )}

      {isAdmin && (
        <section style={s.section}>
          <SectionTitle>
            Manage Monitors
            <span style={s.adminTag}>admin only</span>
          </SectionTitle>
          <form onSubmit={handleAddUrl} style={s.addForm}>
            <input
              style={s.addInput}
              type="url"
              placeholder="https://example.com"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              required
            />
            <button style={{ ...s.addBtn, opacity: adding ? 0.6 : 1 }} type="submit" disabled={adding}>
              {adding ? "Adding…" : "+ Add monitor"}
            </button>
          </form>
          {addError && <div style={s.addError} role="alert">{addError}</div>}
        </section>
      )}

      <section style={s.section}>
        <SectionTitle>Monitored Endpoints</SectionTitle>
        {sortedMonitors.length === 0 ? (
          <div style={s.empty}>
            {connected
              ? "Waiting for first results… (checks run every 5–60s)"
              : "Connecting to backend…"}
          </div>
        ) : (
          <div style={s.grid}>
            {sortedMonitors.map((monitor) => (
              <UrlCard
                key={monitor.id}
                url={monitor.url}
                name={monitor.name}
                monitorId={monitor.id}
                enabled={monitor.enabled}
                results={monitorData[monitor.id] || []}
                canRemove={isAdmin}
                onRemove={() => handleRemoveMonitor(monitor.id)}
              />
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}

function SectionTitle({ children }) {
  return <div style={st.title}>{children}</div>;
}
function Pill({ label, sub, color }) {
  return (
    <div style={{ ...st.pill, borderColor: color + "44" }}>
      <span style={{ ...st.pillVal, color }}>{label}</span>
      <span style={st.pillSub}>{sub}</span>
    </div>
  );
}

const s = {
  pageHeader: { display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:"16px", marginBottom:"28px" },
  h1:         { fontSize:"22px", fontWeight:800, color:"#e2e8f0", margin:0 },
  subtitle:   { fontSize:"12px", color:"#4a5568", marginTop:"4px" },
  pills:      { display:"flex", gap:"10px", flexWrap:"wrap" },
  section:    { marginBottom:"28px" },
  grid:       { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(330px, 1fr))", gap:"14px" },
  empty:      { color:"#4a5568", textAlign:"center", padding:"48px 0", fontSize:"14px" },
  adminTag:   { fontSize:"10px", fontWeight:700, letterSpacing:"0.07em", background:"#22543d", color:"#68d391", padding:"2px 7px", borderRadius:"4px", marginLeft:"10px" },
  addForm:    { display:"flex", gap:"8px", maxWidth:"520px" },
  addInput:   { flex:1, background:"#0f1117", border:"1px solid #2d3748", borderRadius:"8px", padding:"9px 12px", fontSize:"13px", color:"#e2e8f0", outline:"none" },
  addBtn:     { background:"#4FD1C5", color:"#0f1117", border:"none", borderRadius:"8px", padding:"9px 18px", fontSize:"13px", fontWeight:700, cursor:"pointer" },
  addError:   { marginTop:"8px", fontSize:"12px", color:"#fc8181", background:"#742a2a33", border:"1px solid #742a2a", borderRadius:"6px", padding:"7px 10px" },
};
const st = {
  title:   { fontSize:"11px", color:"#4a5568", textTransform:"uppercase", letterSpacing:"0.09em", marginBottom:"12px", display:"flex", alignItems:"center", gap:"0" },
  pill:    { display:"flex", flexDirection:"column", alignItems:"center", background:"#1a202c", border:"1px solid", borderRadius:"8px", padding:"8px 14px", minWidth:"72px" },
  pillVal: { fontSize:"18px", fontWeight:800, lineHeight:1.1 },
  pillSub: { fontSize:"10px", color:"#4a5568", textTransform:"uppercase", letterSpacing:"0.06em", marginTop:"2px" },
};
