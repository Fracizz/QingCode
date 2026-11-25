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
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// QingCode Android WebView assets served unchanged; the fixture bridge replaces MainActivity.
var mobileAssets = {
    'app.js': ['mobile/android/web/app.js', 'text/javascript'],
    'protocol.js': ['mobile/android/web/protocol.js', 'text/javascript'],
    'themeBoot.js': ['mobile/android/web/themeBoot.js', 'text/javascript'],
    'scanner.js': ['mobile/android/web/scanner.js', 'text/javascript'],
    'terminalTouch.js': ['mobile/android/web/terminalTouch.js', 'text/javascript'],
    'gestures.js': ['mobile/android/web/gestures.js', 'text/javascript'],
    'composer.js': ['mobile/android/web/composer.js', 'text/javascript'],
    'terminalHistory.js': ['mobile/android/web/terminalHistory.js', 'text/javascript'],
    'terminalScrollbar.js': ['mobile/android/web/terminalScrollbar.js', 'text/javascript'],
    'terminalJog.js': ['mobile/android/web/terminalJog.js', 'text/javascript'],
    'terminalHold.js': ['mobile/android/web/terminalHold.js', 'text/javascript'],
    'historyRender.js': ['mobile/android/web/historyRender.js', 'text/javascript'],
    'terminalSelection.js': ['mobile/android/web/terminalSelection.js', 'text/javascript'],
    'connectionLatency.js': ['mobile/android/web/connectionLatency.js', 'text/javascript'],
    'workspaceState.js': ['mobile/android/web/workspaceState.js', 'text/javascript'],
    'nativeRpc.js': ['mobile/android/web/nativeRpc.js', 'text/javascript'],
    'outputFeed.js': ['mobile/android/web/outputFeed.js', 'text/javascript'],
    'terminalInput.js': ['mobile/android/web/terminalInput.js', 'text/javascript'],
    'desktopProtocol.js': ['mobile/android/web/desktopProtocol.js', 'text/javascript'],
    'terminalImages.js': ['mobile/android/web/terminalImages.js', 'text/javascript'],
    'fileBrowser.js': ['mobile/android/web/fileBrowser.js', 'text/javascript'],
    'fileBrowserState.js': ['mobile/android/web/fileBrowserState.js', 'text/javascript'],
    'dom.js': ['mobile/android/web/dom.js', 'text/javascript'],
    'selectMenu.js': ['mobile/android/web/selectMenu.js', 'text/javascript'],
    'dashboardView.js': ['mobile/android/web/dashboardView.js', 'text/javascript'],
    'pairingFlow.js': ['mobile/android/web/pairingFlow.js', 'text/javascript'],
    'outputReader.js': ['mobile/android/web/outputReader.js', 'text/javascript'],
    'composeStatus.js': ['mobile/android/web/composeStatus.js', 'text/javascript'],
    'newSessionDialog.js': ['mobile/android/web/newSessionDialog.js', 'text/javascript'],
    'sessionDrawer.js': ['mobile/android/web/sessionDrawer.js', 'text/javascript'],
    'sessionOverview.js': ['mobile/android/web/sessionOverview.js', 'text/javascript'],
    'sessionPrefs.js': ['mobile/android/web/sessionPrefs.js', 'text/javascript'],
    'terminalSettings.js': ['mobile/android/web/terminalSettings.js', 'text/javascript'],
    'shortcutBar.js': ['mobile/android/web/shortcutBar.js', 'text/javascript'],
    'keyLayout.js': ['mobile/android/web/keyLayout.js', 'text/javascript'],
    'cursorDrag.js': ['mobile/android/web/cursorDrag.js', 'text/javascript'],
    'pinchZoom.js': ['mobile/android/web/pinchZoom.js', 'text/javascript'],
    'terminalLinks.js': ['mobile/android/web/terminalLinks.js', 'text/javascript'],
    'i18n.js': ['mobile/android/web/i18n.js', 'text/javascript'],
    'appUpdate.js': ['mobile/android/web/appUpdate.js', 'text/javascript'],
    'updateView.js': ['mobile/android/web/updateView.js', 'text/javascript'],
    'mouseMode.js': ['mobile/android/web/mouseMode.js', 'text/javascript'],
    'historySelection.js': ['mobile/android/web/historySelection.js', 'text/javascript'],
    'terminalFont.js': ['mobile/android/web/terminalFont.js', 'text/javascript'],
    'terminalRenderer.js': ['mobile/android/web/terminalRenderer.js', 'text/javascript'],
    'sessionWatch.js': ['mobile/android/web/sessionWatch.js', 'text/javascript'],
    'heroHeader.js': ['mobile/android/web/heroHeader.js', 'text/javascript'],
    'motion.js': ['mobile/android/web/motion.js', 'text/javascript'],
    'app.css': ['mobile/android/web/app.css', 'text/css'],
    'xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
    'xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
    'fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
    'unicode11.js': ['node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js', 'text/javascript'],
    'webgl.js': ['node_modules/@xterm/addon-webgl/lib/addon-webgl.js', 'text/javascript'],
    'jsqr.js': ['node_modules/jsqr/dist/jsQR.js', 'text/javascript'],
    'qingcode-icon.png': ['src-tauri/icons/128x128@2x.png', 'image/png'],
    'qingcode-symbols.woff2': ['mobile/android/web/qingcode-symbols.woff2', 'font/woff2'],
};
// A separate dev server keeps fixtures and memory adapters out of the desktop build.
export default defineConfig({
    cacheDir: '.dev/vite-web-test-cache',
    optimizeDeps: { entries: ['web-tests/index.html', 'web-tests/ssh-repair.html', 'web-tests/ssh-warmup.html', 'web-tests/ui-clarity.html', 'web-tests/terminal-exit.html', 'web-tests/app-close.html', 'web-tests/direct-agent.html', 'web-tests/ssh-server-recovery.html', 'web-tests/remote-connections.html', 'web-tests/scm-branches.html'] },
    plugins: [
        react(),
        tailwindcss(),
        {
            name: 'qingcode-web-test-page',
            configureServer: function (server) {
                var _this = this;
                server.middlewares.use(function (request, response, next) {
                    var _a;
                    var match = /^\/mobile-android\/([^?]*)/.exec((_a = request.url) !== null && _a !== void 0 ? _a : '');
                    if (!match)
                        return next();
                    var name = match[1] || 'index.html';
                    var send = function () { return __awaiter(_this, void 0, void 0, function () {
                        var html, asset, _a, _b;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    if (!(name === 'index.html')) return [3 /*break*/, 2];
                                    return [4 /*yield*/, readFile(resolve(import.meta.dirname, 'mobile/android/web/index.html'), 'utf8')];
                                case 1:
                                    html = _c.sent();
                                    response.setHeader('content-type', 'text/html; charset=utf-8');
                                    response.end(html.replace('<head>', '<head>\n  <script src="/web-tests/mobile-android-bridge.js"></script>'));
                                    return [2 /*return*/];
                                case 2:
                                    asset = mobileAssets[name];
                                    if (!asset) {
                                        response.statusCode = 404;
                                        response.end();
                                        return [2 /*return*/];
                                    }
                                    response.setHeader('content-type', asset[1]);
                                    _b = (_a = response).end;
                                    return [4 /*yield*/, readFile(resolve(import.meta.dirname, asset[0]))];
                                case 3:
                                    _b.apply(_a, [_c.sent()]);
                                    return [2 /*return*/];
                            }
                        });
                    }); };
                    send().catch(next);
                });
                server.middlewares.use(function (request, _response, next) {
                    var _a;
                    if (request.url === '/' || ((_a = request.url) === null || _a === void 0 ? void 0 : _a.startsWith('/?'))) {
                        request.url = "/web-tests/index.html".concat(request.url.slice(1));
                    }
                    next();
                });
            },
        },
    ],
    resolve: {
        alias: [
            {
                find: /^.*\/(?:projectStore|uiStore|terminalStore|editorStore|workspaceTrust|projectActions|namedWorkspaceActions)$/,
                replacement: resolve(import.meta.dirname, 'src/test-pages/projectManagerAdapters.ts'),
            },
            { find: '@', replacement: resolve(import.meta.dirname, 'src') },
        ],
    },
    server: {
        host: '127.0.0.1',
        port: 38439,
        strictPort: true,
        watch: { ignored: ['**/.dev/**', '**/src-tauri/**', '**/dist/**', '**/release/**', '**/coverage/**'] },
    },
});
