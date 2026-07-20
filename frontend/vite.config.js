import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // All /api/* routes → backend (includes auth, endpoints, polling-stats)
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // withCredentials isn't a proxy option — the browser sends cookies
        // because the request appears same-origin to it (same host:port via proxy)
      },
      // Socket.io handshake + WebSocket upgrade
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,           // required for the WebSocket upgrade
        changeOrigin: true,
      },
    },
  },
});
