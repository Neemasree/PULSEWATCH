/**
 * api.js
 * Fetch wrapper for all backend API calls.
 *
 * KEY DESIGN: the auto-refresh interceptor only fires on DATA routes.
 * Auth-probe calls (api.me, api.login, api.logout, api.refresh) must
 * NEVER trigger the refresh loop — a 401 from those routes is expected
 * and means "not logged in", not "token expired, please refresh".
 *
 * Without this guard:
 *   AuthContext.mount → api.me() → 401 → refresh → 401 → redirect /login
 *   → page reloads → AuthContext.mount → api.me() → ... (infinite loop)
 *   This is what was freezing typing and causing the @react-refresh error.
 */

const BASE = import.meta.env.VITE_BACKEND_URL || "";

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

let _isRefreshing = false;

/**
 * @param {string}  method
 * @param {string}  path
 * @param {*}       body
 * @param {object}  opts
 * @param {boolean} opts.skipRefresh  — if true, a 401 throws immediately
 *                                      instead of triggering the refresh loop
 * @param {boolean} opts.retrying     — internal flag, prevents double-refresh
 */
async function request(method, path, body, { skipRefresh = false, retrying = false } = {}) {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());

  const headers = { "Content-Type": "application/json" };
  if (isMutating) headers["X-CSRF-Token"] = getCsrfToken();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });

  // ── Auto-refresh on 401 ───────────────────────────────────────────────────
  // Only runs for DATA routes (skipRefresh=false) and only once (retrying=false).
  // Auth routes (me, login, refresh, logout) always pass skipRefresh=true so
  // a 401 from them just throws — it means "not authenticated", not "expired token".
  if (res.status === 401 && !skipRefresh && !retrying && !_isRefreshing) {
    _isRefreshing = true;
    try {
      const refreshRes = await fetch(`${BASE}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });

      if (!refreshRes.ok) {
        // Refresh token also expired/missing — session is truly dead
        // Use React Router navigation instead of hard reload to avoid HMR conflict
        window.dispatchEvent(new CustomEvent("pw:session-expired"));
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Session expired");
      }
    } finally {
      _isRefreshing = false;
    }
    // Retry with the fresh access_token cookie now set
    return request(method, path, body, { skipRefresh, retrying: true });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth routes — skipRefresh:true so 401 never triggers the refresh loop
  login:   (u, p) => request("POST", "/api/auth/login",   { username: u, password: p }, { skipRefresh: true }),
  refresh: ()     => request("POST", "/api/auth/refresh",  null,                         { skipRefresh: true }),
  logout:  ()     => request("POST", "/api/auth/logout",   null,                         { skipRefresh: true }),
  me:      ()     => request("GET",  "/api/auth/me",       null,                         { skipRefresh: true }),

  // Public — no auth needed, but still no refresh loop
  publicStatus: () => request("GET", "/api/public/status", null, { skipRefresh: true }),

  // Data routes — 401 triggers silent refresh + retry
  pollingStats:   ()    => request("GET",    "/api/polling-stats"),
  endpoints:      ()    => request("GET",    "/api/endpoints"),
  addEndpoint:    (url) => request("POST",   "/api/endpoints", { url }),
  removeEndpoint: (url) => request("DELETE", "/api/endpoints", { url }),
  check:          (url) => request("GET",    `/api/check?url=${encodeURIComponent(url)}`),
};
