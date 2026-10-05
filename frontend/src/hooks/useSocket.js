/**
 * useSocket.js
 * Socket.io — authenticates via the httpOnly access_token cookie.
 *
 * Data is keyed by monitorId (not URL) to support two monitors
 * pointing at the same URL independently.
 *
 * Events subscribed:
 *   initial-data    { [monitorId]: result[] }   — catch-up on connect
 *   metric-update   { monitorId, ... }           — live ping result
 *   polling-stats   { ... }                      — adaptive polling stats
 *   incident-update { type, monitorId, ... }     — incident lifecycle event
 *     type = 'opened'      → { monitorId, incidentId, startedAt }
 *     type = 'acknowledged'→ { monitorId, incidentId, acknowledgedAt }
 *     type = 'resolved'    → { monitorId, incidentId, resolvedAt, durationMs }
 *
 * Architecture note:
 *   useSocket is NOT the source of truth for incident history.
 *   Callers fetch complete history from REST (GET /api/incidents or
 *   GET /api/public/incidents) on mount, then apply incidentEvents
 *   in real time to update that state. This hook only delivers the
 *   stream of changes — it does not accumulate a full history list.
 */

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";
const MAX_HISTORY = 20;

export function useSocket(user) {
  const [monitorData,    setMonitorData]    = useState({}); // { [monitorId]: result[] }
  const [pollingStats,   setPollingStats]   = useState(null);
  const [connected,      setConnected]      = useState(false);
  const [incidentEvents, setIncidentEvents] = useState([]); // latest incident-update events
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

    // Incident lifecycle events — callers apply these to their own state
    socket.on("incident-update", (event) => {
      setIncidentEvents((prev) => [event, ...prev].slice(0, 50));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setMonitorData({});
      setPollingStats(null);
      setConnected(false);
      setIncidentEvents([]);
    };
  }, [user?.id]);

  return { monitorData, pollingStats, connected, incidentEvents };
}
