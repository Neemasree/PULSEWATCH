/**
 * socketHandler.js
 * Socket.io — per-user rooms, data keyed by monitorId.
 *
 * Room scheme:
 *   user:<id>  — receives only that user's monitor data
 *   admin      — receives all monitor data
 *
 * initial-data payload: { [monitorId]: result[] }
 * metric-update payload: { monitorId, url, status, ... }
 */

const { verifyAccessToken }  = require("./auth");
const { getRecentMetrics }   = require("./redisClient");
const { getMonitorsForUser } = require("./poller");
const { getActiveMonitors }  = require("./endpointRegistry");

let _io = null;

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    }).filter(([k]) => k)
  );
}

function userRoom(userId) { return `user:${userId}`; }

function initSocketHandler(io) {
  _io = io;

  io.use((socket, next) => {
    const cookies     = parseCookies(socket.handshake.headers.cookie || "");
    const cookieToken = cookies.access_token;
    const authToken   = socket.handshake.auth?.token;
    const token       = cookieToken || authToken;
    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", async (socket) => {
    const { sub: userId, username, role } = socket.data.user;
    const isAdmin = role === "admin";

    socket.join(userRoom(userId));
    if (isAdmin) socket.join("admin");

    console.log(`[WS] Connected: ${socket.id} (${username}/${role}) → room ${userRoom(userId)}`);

    // Catch-up: send last 20 results per monitor, keyed by monitorId
    try {
      const monitors    = getMonitorsForUser(userId, isAdmin);
      const initialData = {};
      await Promise.all(monitors.map(async (m) => {
        try { initialData[m.id] = await getRecentMetrics(m.id, 20); }
        catch { initialData[m.id] = []; }
      }));
      socket.emit("initial-data", initialData);
    } catch (err) {
      console.error("[WS] initial-data failed:", err.message);
      socket.emit("initial-data", {});
    }

    socket.on("disconnect", (reason) => {
      console.log(`[WS] Disconnected: ${socket.id} (${reason})`);
    });
  });
}

/**
 * Broadcasts a metric result to the owning user's room and the admin room.
 * result must carry monitorId.
 */
function broadcastMetric(result) {
  if (!_io) return;
  const { monitorId } = result;

  const ownerIds = new Set();
  for (const m of getActiveMonitors()) {
    if (m.id === monitorId) ownerIds.add(String(m.user_id));
  }
  for (const uid of ownerIds) {
    _io.to(userRoom(uid)).emit("metric-update", result);
  }
  _io.to("admin").emit("metric-update", result);
}

function broadcastPollingStats(stats) {
  if (!_io) return;
  const owners = new Set(getActiveMonitors().map((monitor) => String(monitor.user_id)));
  if (owners.size === 0) {
    _io.to("admin").emit("polling-stats", stats);
    return;
  }
  for (const userId of owners) {
    const userStats = require("./poller").getPollingState(userId, false);
    _io.to(userRoom(userId)).emit("polling-stats", userStats);
  }
  _io.to("admin").emit("polling-stats", stats);
}

/**
 * Broadcasts an incident lifecycle event to the owning user's room + admin room.
 * event shape: { type: 'opened'|'acknowledged'|'resolved', monitorId, incidentId, ... }
 */
function broadcastIncidentUpdate(event) {
  if (!_io) return;
  const { monitorId } = event;
  const ownerIds = new Set();
  for (const m of getActiveMonitors()) {
    if (m.id === monitorId) ownerIds.add(String(m.user_id));
  }
  for (const uid of ownerIds) {
    _io.to(userRoom(uid)).emit("incident-update", event);
  }
  _io.to("admin").emit("incident-update", event);
}

module.exports = { initSocketHandler, broadcastMetric, broadcastPollingStats, broadcastIncidentUpdate, userRoom };
