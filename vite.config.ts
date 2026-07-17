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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
