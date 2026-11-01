import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_BACKEND ??
  "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/media": backend,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
