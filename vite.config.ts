import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { readFileSync } from "fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const DEFAULT_DEV_PORT = 38417;
const devPort = Number(process.env.VITE_DEV_PORT) || DEFAULT_DEV_PORT;
const devPortLocked = Boolean(process.env.VITE_DEV_PORT);

// Expose the app version (package.json) to the browser bundle so non-Tauri
// surfaces (e.g. `pnpm dev` Settings → 关于) can show it without the Tauri API.
const appVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
})();

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), tailwindcss()],

  define: {
    "import.meta.env.QINGCODE_VERSION": JSON.stringify(appVersion),
  },

  // `@` -> src/ alias (used by the lib/ terminal & git pilot subdirectories).
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri:dev sets VITE_DEV_PORT (default 38417); plain `pnpm dev` can auto-increment if free
  server: {
    port: devPort,
    strictPort: devPortLocked,
    host: host || "127.0.0.1",
    // Tests use cold boot and explicit reload; HMR can replace live IPC subscribers.
    hmr: mode === 'web-test' ? false : host
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
    // CodeMirror core (@codemirror/view etc.) is inherently large; language packs
    // and other heavy deps are already split. Keep the advisory threshold above
    // the remaining shared editor vendor chunk.
    chunkSizeWarningLimit: 800,
    // Keep Vite 7's browser floor; a bundler upgrade must not raise the
    // minimum supported WebView/Safari version implicitly.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'codemirror',
              test(id) {
                const path = id.replaceAll('\\', '/')
                if (!path.includes('node_modules')) return false
                // Language packs and merge remain separate async chunks.
                if (/\/@codemirror\/(?:lang-|legacy-modes|merge)/.test(path)) return false
                return /\/(?:@codemirror|codemirror|@lezer)\//.test(path)
              },
            },
            {
              name: 'xterm',
              test: /node_modules[\\/](?:@xterm[\\/](?!addon-webgl)|xterm[\\/])/,
            },
            { name: 'tauri', test: /node_modules[\\/]@tauri-apps[\\/]/ },
            { name: 'react-vendor', test: /node_modules[\\/](?:react|react-dom)[\\/]/ },
          ],
        },
      },
    },
  },
}))
