import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

// Single source of truth for the app version: package.json. Injected as
// __APP_VERSION__ so the About page and the plugin minAppVersion gate can't
// drift from it (they used to hard-code their own copy).
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      // Lets plugin sources under src/plugins/* build both ways: compiled into
      // the app (this config) and as external signed bundles
      // (vite.plugin.config.ts). Both resolve to the same host SDK contract.
      "@openbricx/host": fileURLToPath(new URL("./plugin-sdk/host.ts", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
