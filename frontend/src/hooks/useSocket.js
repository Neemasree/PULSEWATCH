/**
 * useSocket.js
 * Socket.io — authenticates via the httpOnly access_token cookie.
 *
 * Key timing fix:
 *   The socket must not connect BEFORE the login cookie exists. We receive
 *   the `user` object as a prop (set by AuthContext after a successful login).
 *   The effect re-runs when `user` changes, so:
 *     - No user → no socket opened
 *     - User just logged in → effect fires, socket opens, cookie is already set
 *     - User logs out → cleanup disconnects the socket
 *
 * Transport note:
 *   Default order ["polling", "websocket"] — do NOT override.
 *   Polling does the HTTP handshake first; that HTTP request carries the
 *   Cookie header. The server's socket middleware reads access_token from it.
 */

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";
const MAX_HISTORY = 20;

export function useSocket(user) {
  const [urlData,      setUrlData]      = useState({});
  const [pollingStats, setPollingStats] = useState(null);
  const [connected,    setConnected]    = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    // Don't open a socket until we know the user is authenticated.
    // At this point the httpOnly access_token cookie is already set by the server.
    if (!user) return;

    const socket = io(BACKEND_URL, {
      withCredentials: true,        // send Cookie header on handshake
      reconnectionDelay:    1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on("connect",      () => setConnected(true));
    socket.on("disconnect",   () => setConnected(false));
    socket.on("connect_error", (err) => {
      console.warn("[Socket] connect_error:", err.message);
      setConnected(false);
    });

    // Catch-up: server sends last 20 results per URL on first connect
    socket.on("initial-data", (data) => setUrlData(data));

    socket.on("metric-update", (result) => {
      setUrlData((prev) => {
        const existing = prev[result.url] || [];
        return { ...prev, [result.url]: [result, ...existing].slice(0, MAX_HISTORY) };
      });
    });

    socket.on("polling-stats", setPollingStats);

    socket.on("endpoints-updated", ({ urls }) => {
      setUrlData((prev) => {
        const next = { ...prev };
        urls.forEach((u) => { if (!next[u]) next[u] = []; });
        return next;
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      // Reset state on logout so old data doesn't flash for the next user
      setUrlData({});
      setPollingStats(null);
      setConnected(false);
    };
  }, [user?.id]); // reconnect only when the user identity changes

  return { urlData, pollingStats, connected };
}
