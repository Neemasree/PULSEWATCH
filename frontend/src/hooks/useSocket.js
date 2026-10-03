/**
 * useSocket.js
 * Socket.io — authenticates via the httpOnly access_token cookie.
 *
 * Data is now keyed by monitorId (not URL) to support two monitors
 * pointing at the same URL independently.
 *
 * initial-data payload: { [monitorId]: result[] }
 * metric-update payload: { monitorId, url, status, ... }
 */

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";
const MAX_HISTORY = 20;

export function useSocket(user) {
  const [monitorData,  setMonitorData]  = useState({}); // { [monitorId]: result[] }
  const [pollingStats, setPollingStats] = useState(null);
  const [connected,    setConnected]    = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!user) return;

    const socket = io(BACKEND_URL, {
      withCredentials: true,
      reconnectionDelay:    1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on("connect",       () => setConnected(true));
    socket.on("disconnect",    () => setConnected(false));
    socket.on("connect_error", (err) => {
      console.warn("[Socket] connect_error:", err.message);
      setConnected(false);
    });

    // Catch-up: { [monitorId]: result[] }
    socket.on("initial-data", (data) => setMonitorData(data));

    socket.on("metric-update", (result) => {
      const key = result.monitorId;
      setMonitorData((prev) => {
        const existing = prev[key] || [];
        return { ...prev, [key]: [result, ...existing].slice(0, MAX_HISTORY) };
      });
    });

    socket.on("polling-stats", setPollingStats);

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setMonitorData({});
      setPollingStats(null);
      setConnected(false);
    };
  }, [user?.id]);

  return { monitorData, pollingStats, connected };
}
