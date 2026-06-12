import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Vite configuration.
 *
 * The dev server proxies all `/api/*` requests to the local Express proxy
 * (server/proxy.ts) so the browser never talks to OpenSky directly and
 * never hits a CORS wall.
 */
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL("./index.html", import.meta.url)),
        app: fileURLToPath(new URL("./app.html", import.meta.url)),
      },
    },
  },
});
