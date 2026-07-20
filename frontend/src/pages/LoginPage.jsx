import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const SECURITY_FEATURES = [
  { icon: "🔐", label: "bcrypt-12 password hashing" },
  { icon: "🍪", label: "httpOnly cookies — no XSS token theft" },
  { icon: "🔄", label: "Refresh token rotation & blacklist" },
  { icon: "🛡️", label: "Rate limiting + account lockout" },
  { icon: "🚦", label: "CSRF double-submit protection" },
  { icon: "👤", label: "Server-enforced RBAC" },
];

export default function LoginPage() {
  const { login } = useAuth();
  const navigate  = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [showPwd,  setShowPwd]  = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleGuest() {
    setError("");
    setLoading(true);
    try {
      await login("guest", "guest123");
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message || "Guest login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.page}>
      <div style={s.grid}>

        {/* ── Left panel: feature list ─────────────────────────────── */}
        <div style={s.left}>
          <div style={s.brand}>
            <span style={s.brandIcon}>⚡</span>
            <span style={s.brandText}>PulseWatch</span>
          </div>
          <p style={s.brandSub}>
            Real-time uptime monitoring with adaptive polling &amp; anomaly detection
          </p>

          <div style={s.featureList}>
            <div style={s.featureHeading}>Security features</div>
            {SECURITY_FEATURES.map(({ icon, label }) => (
              <div key={label} style={s.featureRow}>
                <span style={s.featureIcon}>{icon}</span>
                <span style={s.featureLabel}>{label}</span>
              </div>
            ))}
          </div>

          <Link to="/status" style={s.statusLink}>
            <span style={s.statusDot} />
            View public status page
          </Link>
        </div>

        {/* ── Right panel: login form ──────────────────────────────── */}
        <div style={s.card}>
          <h1 style={s.h1}>Sign in</h1>
          <p style={s.h1Sub}>to your PulseWatch dashboard</p>

          <form onSubmit={handleSubmit} style={s.form}>
            <Field label="Username" id="username">
              <input
                id="username" style={s.input}
                type="text" autoComplete="username"
                value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="admin or guest" required
              />
            </Field>

            <Field label="Password" id="password">
              <div style={s.pwdWrap}>
                <input
                  id="password" style={{ ...s.input, paddingRight: "44px" }}
                  type={showPwd ? "text" : "password"}
                  autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••" required
                />
                <button
                  type="button" onClick={() => setShowPwd(!showPwd)}
                  style={s.eyeBtn} aria-label={showPwd ? "Hide password" : "Show password"}
                >
                  {showPwd ? "○" : "●"}
                </button>
              </div>
            </Field>

            {error && (
              <div style={s.errorBox} role="alert">
                <span style={s.errorIcon}>⚠</span>
                {error}
              </div>
            )}

            <button
              style={{ ...s.primaryBtn, opacity: loading ? 0.7 : 1 }}
              type="submit" disabled={loading}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>

            <div style={s.divider}><span>or</span></div>

            <button
              type="button"
              style={{ ...s.ghostBtn, opacity: loading ? 0.7 : 1 }}
              onClick={handleGuest} disabled={loading}
            >
              Continue as Guest
              <span style={s.guestBadge}>read-only</span>
            </button>
          </form>

          {/* Demo credentials */}
          <div style={s.credsBox}>
            <div style={s.credsTitle}>Demo credentials</div>
            <CredRow role="admin" cred="admin / admin123" note="full control" />
            <CredRow role="guest" cred="guest / guest123" note="read-only" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, id, children }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"6px" }}>
      <label htmlFor={id} style={s.label}>{label}</label>
      {children}
    </div>
  );
}

function CredRow({ role, cred, note }) {
  const isAdmin = role === "admin";
  return (
    <div style={s.credRow}>
      <span style={s.credRole(isAdmin)}>{role}</span>
      <code style={s.credCode}>{cred}</code>
      <span style={s.credNote}>{note}</span>
    </div>
  );
}

const s = {
  page: {
    minHeight: "100vh",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "radial-gradient(ellipse at 30% 50%, #0d1520 0%, #0a0d14 70%)",
    padding: "24px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    maxWidth: "820px", width: "100%",
    gap: "0",
    borderRadius: "16px",
    overflow: "hidden",
    border: "1px solid #1e2535",
    boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
  },

  // Left
  left: {
    background: "#0f1420",
    padding: "40px 32px",
    display: "flex", flexDirection: "column", gap: "24px",
    borderRight: "1px solid #1e2535",
  },
  brand:    { display:"flex", alignItems:"center", gap:"10px" },
  brandIcon:{ fontSize:"24px" },
  brandText:{ fontSize:"20px", fontWeight:800, color:"#4FD1C5", letterSpacing:"-0.02em" },
  brandSub: { fontSize:"13px", color:"#3d4a5c", lineHeight:1.6, marginTop:"-12px" },
  featureList:    { display:"flex", flexDirection:"column", gap:"10px" },
  featureHeading: { fontSize:"10px", color:"#2d3748", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:"2px" },
  featureRow:  { display:"flex", alignItems:"center", gap:"10px" },
  featureIcon: { fontSize:"14px", flexShrink:0 },
  featureLabel:{ fontSize:"12px", color:"#5a6478" },
  statusLink: {
    display:"flex", alignItems:"center", gap:"8px",
    fontSize:"12px", color:"#4FD1C5", textDecoration:"none",
    marginTop:"auto", paddingTop:"16px", borderTop:"1px solid #1e2535",
  },
  statusDot: {
    width:7, height:7, borderRadius:"50%",
    background:"#48bb78", boxShadow:"0 0 5px #48bb78", flexShrink:0,
  },

  // Right (form card)
  card: {
    background: "#0a0d14",
    padding: "40px 36px",
    display: "flex", flexDirection: "column", gap: "20px",
  },
  h1:    { fontSize:"22px", fontWeight:800, color:"#e2e8f0", margin:0 },
  h1Sub: { fontSize:"13px", color:"#3d4a5c", marginTop:"-12px" },
  form:  { display:"flex", flexDirection:"column", gap:"16px" },
  label: { fontSize:"11px", fontWeight:600, color:"#5a6478", textTransform:"uppercase", letterSpacing:"0.07em" },
  input: {
    width:"100%", background:"#0f1420",
    border:"1px solid #1e2535", borderRadius:"8px",
    padding:"11px 13px", fontSize:"14px", color:"#e2e8f0",
    outline:"none", boxSizing:"border-box",
    transition:"border-color 0.15s",
  },
  pwdWrap:  { position:"relative" },
  eyeBtn:   {
    position:"absolute", right:"12px", top:"50%", transform:"translateY(-50%)",
    background:"none", border:"none", color:"#3d4a5c", cursor:"pointer",
    fontSize:"12px", padding:"2px",
  },
  errorBox: {
    display:"flex", alignItems:"center", gap:"8px",
    background:"rgba(116,42,42,0.25)", border:"1px solid #742a2a",
    borderRadius:"8px", padding:"10px 12px",
    fontSize:"13px", color:"#fc8181",
  },
  errorIcon: { flexShrink:0 },
  primaryBtn: {
    background:"#4FD1C5", color:"#0a0d14",
    border:"none", borderRadius:"8px",
    padding:"12px", fontSize:"14px", fontWeight:700,
    cursor:"pointer", transition:"opacity 0.15s",
    letterSpacing:"0.01em",
  },
  divider: {
    display:"flex", alignItems:"center", gap:"12px",
    color:"#1e2535", fontSize:"12px",
    "::before": { content:'""', flex:1, height:"1px", background:"#1e2535" },
    "::after":  { content:'""', flex:1, height:"1px", background:"#1e2535" },
  },
  ghostBtn: {
    display:"flex", alignItems:"center", justifyContent:"center", gap:"10px",
    background:"transparent", color:"#5a6478",
    border:"1px solid #1e2535", borderRadius:"8px",
    padding:"11px", fontSize:"13px", fontWeight:600,
    cursor:"pointer", transition:"border-color 0.15s, color 0.15s",
  },
  guestBadge: {
    fontSize:"10px", fontWeight:700, letterSpacing:"0.06em",
    background:"#1e2535", color:"#4a5568",
    padding:"1px 6px", borderRadius:"4px",
  },
  credsBox:  {
    background:"#0f1420", border:"1px solid #1e2535",
    borderRadius:"10px", padding:"14px 16px",
    display:"flex", flexDirection:"column", gap:"8px",
  },
  credsTitle: { fontSize:"10px", color:"#3d4a5c", textTransform:"uppercase", letterSpacing:"0.08em" },
  credRow:    { display:"flex", alignItems:"center", gap:"8px", flexWrap:"wrap" },
  credRole:   (isAdmin) => ({
    fontSize:"10px", fontWeight:700,
    padding:"2px 7px", borderRadius:"4px",
    background: isAdmin ? "#22543d" : "#1e2535",
    color:      isAdmin ? "#68d391" : "#4a5568",
    flexShrink:0,
  }),
  credCode: {
    fontSize:"12px", fontFamily:"monospace",
    background:"#1e2535", color:"#c8d0e0",
    padding:"1px 6px", borderRadius:"4px",
  },
  credNote: { fontSize:"11px", color:"#3d4a5c" },
};
