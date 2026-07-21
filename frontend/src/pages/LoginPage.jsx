import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";

export default function LoginPage() {
  const { login, setLoggedInUser } = useAuth();
  const navigate  = useNavigate();

  const [mode, setMode] = useState("signin"); // "signin" | "register"

  // Sign In fields
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Register-only fields
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [showPwd,  setShowPwd]  = useState(false);

  async function handleSignIn(e) {
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

  async function handleRegister(e) {
    e.preventDefault();
    setError("");

    // Client-side validation
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (!/\d/.test(password) || !/[a-zA-Z]/.test(password)) {
      setError("Password must contain at least 1 letter and 1 number");
      return;
    }

    setLoading(true);
    try {
      // api.register() already sets auth cookies on the server and returns the user.
      // Call setLoggedInUser() directly — no second round-trip to /api/auth/login needed.
      const { user } = await api.register(username, password, name);
      setLoggedInUser(user);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.page}>
      <div style={s.grid}>

        {/* ── Left panel: branding ─────────────────────────────────── */}
        <div style={s.left}>
          <div style={s.brand}>
            <span style={s.brandIcon}>⚡</span>
            <span style={s.brandText}>PulseWatch</span>
          </div>
          <p style={s.brandSub}>
            Production-grade uptime monitoring with adaptive polling, anomaly detection,
            and real-time alerts
          </p>

          <div style={s.featureList}>
            <FeatureDot label="JWT auth with refresh token rotation" />
            <FeatureDot label="Role-based access control (RBAC)" />
            <FeatureDot label="Adaptive polling (5s–60s)" />
            <FeatureDot label="Z-score anomaly detection" />
            <FeatureDot label="WebSocket real-time updates" />
            <FeatureDot label="Public status page" />
          </div>

          <Link to="/status" style={s.statusLink}>
            <span style={s.statusDot} />
            View public status page
          </Link>
        </div>

        {/* ── Right panel: form ────────────────────────────────────── */}
        <div style={s.card}>
          {/* Tab toggle */}
          <div style={s.tabBar}>
            <button
              type="button"
              style={s.tab(mode === "signin")}
              onClick={() => {
                setMode("signin");
                setError("");
                setName("");
                setConfirmPassword("");
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              style={s.tab(mode === "register")}
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              Register
            </button>
          </div>

          <h1 style={s.h1}>
            {mode === "signin" ? "Welcome back" : "Create account"}
          </h1>
          <p style={s.h1Sub}>
            {mode === "signin"
              ? "Sign in to access your dashboard"
              : "Register to start monitoring your endpoints"}
          </p>

          <form onSubmit={mode === "signin" ? handleSignIn : handleRegister} style={s.form}>
            <Field label="Username" id="username">
              <input
                id="username" style={s.input}
                type="text" autoComplete="username"
                value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder={mode === "signin" ? "Enter username" : "Choose a username"}
                required
              />
            </Field>

            {mode === "register" && (
              <Field label="Full Name" id="name">
                <input
                  id="name" style={s.input}
                  type="text" autoComplete="name"
                  value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                  required
                />
              </Field>
            )}

            <Field label="Password" id="password">
              <div style={s.pwdWrap}>
                <input
                  id="password" style={{ ...s.input, paddingRight: "44px" }}
                  type={showPwd ? "text" : "password"}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
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

            {mode === "register" && (
              <Field label="Confirm Password" id="confirmPassword">
                <input
                  id="confirmPassword" style={s.input}
                  type={showPwd ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••" required
                />
              </Field>
            )}

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
              {loading
                ? (mode === "signin" ? "Signing in…" : "Creating account…")
                : (mode === "signin" ? "Sign in" : "Create account")}
            </button>
          </form>
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

function FeatureDot({ label }) {
  return (
    <div style={s.featureRow}>
      <span style={s.featureDot} />
      <span style={s.featureLabel}>{label}</span>
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
  brandSub: { fontSize:"13px", color:"#5a6478", lineHeight:1.6, marginTop:"-12px" },
  featureList: { display:"flex", flexDirection:"column", gap:"10px", marginTop:"8px" },
  featureRow:  { display:"flex", alignItems:"center", gap:"10px" },
  featureDot:  {
    width:6, height:6, borderRadius:"50%",
    background:"#4FD1C5", flexShrink:0,
  },
  featureLabel:{ fontSize:"12px", color:"#5a6478", lineHeight:1.5 },
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
  tabBar: {
    display:"flex", gap:"4px",
    background:"#0f1420", borderRadius:"10px",
    padding:"4px",
  },
  tab: (active) => ({
    flex:1, background: active ? "#1e2535" : "transparent",
    border:"none", borderRadius:"7px",
    padding:"10px", fontSize:"13px", fontWeight:600,
    color: active ? "#e2e8f0" : "#3d4a5c",
    cursor:"pointer", transition:"all 0.15s",
  }),
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
};
