import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function AppShell({ connected, children }) {
  const { user, logout } = useAuth();
  const navigate         = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div style={{ display:"flex", minHeight:"100vh", background:"#0a0d14" }}>

      {/* ── Sidebar ────────────────────────────────────────────────── */}
      <aside style={{ ...s.sidebar, width: collapsed ? 52 : 216 }}>

        <div style={s.logoArea}>
          <span style={s.logoMark}>⚡</span>
          {!collapsed && <span style={s.logoText}>PulseWatch</span>}
        </div>

        {/* Live indicator */}
        <div style={s.liveRow}>
          <span style={s.liveDot(connected)} />
          {!collapsed && (
            <span style={s.liveLabel}>
              {connected ? "Live" : "Reconnecting…"}
            </span>
          )}
        </div>

        <nav style={s.nav} aria-label="Main navigation">
          {/* Dashboard — internal React Router link */}
          <NavLink to="/dashboard"
            style={({ isActive }) => ({
              ...s.navLink,
              background: isActive ? "rgba(79,209,197,0.1)" : "transparent",
              color:      isActive ? "#4FD1C5" : "#5a6478",
              borderLeft: `2px solid ${isActive ? "#4FD1C5" : "transparent"}`,
            })}
          >
            <span style={s.navIcon}>◈</span>
            {!collapsed && <span style={s.navLabel}>Dashboard</span>}
          </NavLink>

          {/* Status Page — plain anchor so it always opens a new tab, never triggers React Router */}
          <a
            href="/status"
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...s.navLink, color: "#5a6478", borderLeft: "2px solid transparent", textDecoration: "none" }}
          >
            <span style={s.navIcon}>◉</span>
            {!collapsed && (
              <span style={{ display:"flex", alignItems:"center", gap:"6px" }}>
                <span style={s.navLabel}>Status Page</span>
                <span style={s.extBadge}>↗</span>
              </span>
            )}
          </a>
        </nav>

        <div style={{ flex:1 }} />

        {/* User card */}
        {!collapsed && user && (
          <div style={s.userCard}>
            <div style={s.avatar(user.role)}>
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={s.userName}>{user.name}</div>
              <div style={s.rolePill(user.role)}>{user.role}</div>
            </div>
          </div>
        )}

        <button onClick={handleLogout} style={s.logoutBtn} aria-label="Sign out">
          <span style={{ fontSize:"15px" }}>↩</span>
          {!collapsed && <span>Sign out</span>}
        </button>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={s.collapseBtn}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </aside>

      {/* ── Main content ───────────────────────────────────────────── */}
      <main style={s.main}>{children}</main>
    </div>
  );
}

const s = {
  sidebar: {
    background: "#0f1420",
    borderRight: "1px solid #1e2535",
    display: "flex", flexDirection: "column",
    flexShrink: 0, position: "relative",
    transition: "width 0.2s ease",
  },
  logoArea: {
    display: "flex", alignItems: "center", gap: "10px",
    padding: "18px 14px 14px",
    borderBottom: "1px solid #1e2535",
  },
  logoMark: { fontSize: "18px", flexShrink: 0 },
  logoText: { fontSize: "15px", fontWeight: 800, color: "#4FD1C5", letterSpacing: "-0.02em", whiteSpace: "nowrap" },
  liveRow:  { display:"flex", alignItems:"center", gap:"8px", padding:"8px 14px", borderBottom:"1px solid #0a0d14" },
  liveDot: (ok) => ({
    width:7, height:7, borderRadius:"50%", flexShrink:0,
    background: ok ? "#48bb78" : "#fc8181",
    boxShadow: `0 0 5px ${ok ? "#48bb78" : "#fc8181"}`,
  }),
  liveLabel: { fontSize:"11px", color:"#3d4a5c", whiteSpace:"nowrap" },
  nav:       { display:"flex", flexDirection:"column", padding:"8px 0", gap:"1px" },
  navLink:   {
    display:"flex", alignItems:"center", gap:"10px",
    padding:"9px 14px", textDecoration:"none",
    fontSize:"13px", fontWeight:500,
    transition:"background 0.15s, color 0.15s",
  },
  navIcon:  { fontSize:"14px", flexShrink:0, width:18, textAlign:"center" },
  navLabel: { whiteSpace:"nowrap" },
  extBadge: { fontSize:"9px", color:"#3d4a5c" },
  userCard: {
    display:"flex", alignItems:"center", gap:"10px",
    padding:"12px 14px", borderTop:"1px solid #1e2535",
  },
  avatar: (role) => ({
    width:30, height:30, borderRadius:"8px",
    background: role === "admin" ? "#22543d" : "#1e2535",
    color: role === "admin" ? "#68d391" : "#718096",
    display:"flex", alignItems:"center", justifyContent:"center",
    fontSize:"13px", fontWeight:800, flexShrink:0,
  }),
  userName: { fontSize:"12px", fontWeight:600, color:"#c8d0e0" },
  rolePill: (role) => ({
    display:"inline-block",
    fontSize:"9px", fontWeight:700, letterSpacing:"0.08em",
    textTransform:"uppercase",
    color: role === "admin" ? "#68d391" : "#4a5568",
    marginTop:"1px",
  }),
  logoutBtn: {
    display:"flex", alignItems:"center", gap:"8px",
    background:"none", border:"none", borderTop:"1px solid #1e2535",
    color:"#3d4a5c", cursor:"pointer", fontSize:"12px",
    padding:"11px 14px", width:"100%", transition:"color 0.15s",
  },
  collapseBtn: {
    position:"absolute", right:-11, top:"50%", transform:"translateY(-50%)",
    background:"#1e2535", border:"1px solid #2d3748",
    borderRadius:"50%", width:20, height:20,
    color:"#4a5568", cursor:"pointer", fontSize:"12px",
    display:"flex", alignItems:"center", justifyContent:"center",
    zIndex:10, padding:0,
  },
  main: {
    flex:1, overflowY:"auto",
    padding:"28px 32px", background:"#0a0d14",
  },
};
