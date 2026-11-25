var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { readFileSync } from "fs";
// @ts-expect-error process is a nodejs global
var host = process.env.TAURI_DEV_HOST;
var DEFAULT_DEV_PORT = 38417;
var devPort = Number(process.env.VITE_DEV_PORT) || DEFAULT_DEV_PORT;
var devPortLocked = Boolean(process.env.VITE_DEV_PORT);
// Expose the app version (package.json) to the browser bundle so non-Tauri
// surfaces (e.g. `pnpm dev` Settings → 关于) can show it without the Tauri API.
var appVersion = (function () {
    try {
        var pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8"));
        return typeof pkg.version === "string" ? pkg.version : "";
    }
    catch (_a) {
        return "";
    }
})();
// https://vite.dev/config/
export default defineConfig(function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
    var mode = _b.mode;
    return __generator(this, function (_c) {
        return [2 /*return*/, ({
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
                            host: host,
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
                                        test: function (id) {
                                            var path = id.replaceAll('\\', '/');
                                            if (!path.includes('node_modules'))
                                                return false;
                                            // Language packs and merge remain separate async chunks.
                                            if (/\/@codemirror\/(?:lang-|legacy-modes|merge)/.test(path))
                                                return false;
                                            return /\/(?:@codemirror|codemirror|@lezer)\//.test(path);
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
            })];
    });
}); });
