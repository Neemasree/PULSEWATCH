import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from "react";
import { api } from "../api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);
  // Guard so the session-restore fetch only fires once even in StrictMode
  const didFetch = useRef(false);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;

    // Try to restore session from the httpOnly cookie.
    // api.me has skipRefresh:true so a 401 here just means "not logged in" —
    // it does NOT trigger the refresh interceptor or cause a reload.
    api.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Listen for the session-expired event dispatched by api.js when both
  // access + refresh tokens are gone. Navigate without a hard reload.
  useEffect(() => {
    function onExpired() {
      setUser(null);
      setLoading(false);
      // Use replace so the back button doesn't loop back to a broken page
      window.location.replace("/login");
    }
    window.addEventListener("pw:session-expired", onExpired);
    return () => window.removeEventListener("pw:session-expired", onExpired);
  }, []);

  const login = useCallback(async (username, password) => {
    const { user: u } = await api.login(username, password);
    setUser(u);
    return u;
  }, []);

  // Used after registration — cookies are already set by the server,
  // so we just update local state without making a second login request.
  const setLoggedInUser = useCallback((u) => {
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setLoggedInUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
