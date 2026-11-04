import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tmpdir } from "node:os";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  cacheDir: path.join(tmpdir(), "melodify-vite-cache"),
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3010",
      "/media": "http://localhost:3010",
      "/socket.io": { target: "http://localhost:3010", ws: true },
    },
  },
});
