import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.API_URL ?? "http://127.0.0.1:18787";
const RUNNER = process.env.RUNNER_URL ?? "http://127.0.0.1:18788";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // The admin token stays on this server, so it never reaches the browser.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.setHeader("authorization", `Bearer ${ADMIN_TOKEN}`)),
      },
      "/runner": { target: RUNNER, changeOrigin: true, rewrite: (path) => path.replace(/^\/runner/, "") },
    },
  },
});
