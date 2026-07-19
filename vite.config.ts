import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const DEFAULT_DEV_PORT = 38417;
const devPort = Number(process.env.VITE_DEV_PORT) || DEFAULT_DEV_PORT;
const devPortLocked = Boolean(process.env.VITE_DEV_PORT);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri:dev sets VITE_DEV_PORT (default 38417); plain `pnpm dev` can auto-increment if free
  server: {
    port: devPort,
    strictPort: devPortLocked,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devPort + 1,
        }
      : undefined,
    watch: {
      // 3. ignore native/build/dev-data dirs so SQLite writes under `.dev/`
      // do not thrash HMR while `pnpm tauri:dev` is running.
      ignored: ["**/src-tauri/**", "**/.dev/**", "**/release/**", "**/coverage/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("@codemirror") ||
            id.includes("/codemirror/") ||
            id.includes("@lezer")
          ) {
            return "codemirror";
          }
          if (id.includes("@xterm") || id.includes("/xterm/")) {
            return "xterm";
          }
          if (id.includes("@tauri-apps")) {
            return "tauri";
          }
          if (
            id.includes("/react-dom/") ||
            id.includes("/react/") ||
            id.includes("\\react-dom\\") ||
            id.includes("\\react\\")
          ) {
            return "react-vendor";
          }
        },
      },
    },
  },
}));
