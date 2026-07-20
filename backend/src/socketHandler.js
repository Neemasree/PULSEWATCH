/**
 * socketHandler.js
 * Socket.io — authenticates via httpOnly cookie read from the HTTP handshake.
 *
 * Cookie flow:
 *   The socket.io polling handshake is a regular HTTP request.
 *   The browser sends all cookies for the domain, including access_token.
 *   We parse the Cookie header manually (cookie-parser isn't available in
 *   socket.io middleware) using a small inline parser.
 *
 *   This is why transports must include "polling" — it's the HTTP handshake
 *   that carries the Cookie header. Pure WebSocket upgrades don't include it.
 */

const { verifyAccessToken } = require("./auth");
const { getRecentMetrics }  = require("./redisClient");
const { getUrls }           = require("./poller");

let _io = null;

/** Parses a raw Cookie header string into a plain object. */
function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    }).filter(([k]) => k)
  );
}

function initSocketHandler(io) {
  _io = io;

  // ── JWT middleware — runs before every "connection" event ─────────────────
  io.use((socket, next) => {
    // Read the access_token from the Cookie header of the handshake request
    const cookies    = parseCookies(socket.handshake.headers.cookie || "");
    const cookieToken = cookies.access_token;
    // Fall back to auth.token for non-browser API clients that can't set cookies
    const authToken  = socket.handshake.auth?.token;
    const token      = cookieToken || authToken;

    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", async (socket) => {
    const { username, role } = socket.data.user;
    console.log(`[WS] Connected: ${socket.id} (${username} / ${role})`);

    // Catch-up on reconnect — send last 20 results per URL immediately
    try {
      const initialData = {};
      await Promise.all(getUrls().map(async (url) => {
        try {
          initialData[url] = await getRecentMetrics(url, 20);
        } catch {
          initialData[url] = []; // Redis unavailable for this URL — send empty, don't crash
        }
      }));
      socket.emit("initial-data", initialData);
    } catch (err) {
      console.error("[WS] initial-data failed:", err.message);
      // Still emit an empty object so the frontend doesn't hang waiting
      socket.emit("initial-data", {});
    }

    socket.on("disconnect", (reason) => {
      console.log(`[WS] Disconnected: ${socket.id} (${reason})`);
    });
  });
}

function broadcastMetric(result) {
  if (_io) _io.emit("metric-update", result);
}

function broadcastPollingStats(stats) {
  if (_io) _io.emit("polling-stats", stats);
}

module.exports = { initSocketHandler, broadcastMetric, broadcastPollingStats };
