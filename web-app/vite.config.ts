import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backend =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_BACKEND ??
  "http://localhost:8080";

/**
 * Engine modules hold a live NScripter VM. React Fast Refresh can preserve the
 * React `started` flag while recreating the VM, which leaves a dead player.
 * Force a normal page reload for engine/App changes so the URL/session snapshot
 * restores the current line and menu.
 */
function fullReloadForEngine(): Plugin {
  return {
    name: "amehare-engine-full-reload",
    handleHotUpdate({ file, server }) {
      const f = file.replaceAll("\\", "/");
      if (f.includes("/src/game/") || f.endsWith("/src/App.tsx") || f.endsWith("/src/main.tsx")) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), fullReloadForEngine()],
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
