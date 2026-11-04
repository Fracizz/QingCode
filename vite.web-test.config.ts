import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// QingCode Android WebView assets served unchanged; the fixture bridge replaces MainActivity.
const mobileAssets: Record<string, [string, string]> = {
  'app.js': ['mobile/android/web/app.js', 'text/javascript'],
  'protocol.js': ['mobile/android/web/protocol.js', 'text/javascript'],
  'scanner.js': ['mobile/android/web/scanner.js', 'text/javascript'],
  'terminalTouch.js': ['mobile/android/web/terminalTouch.js', 'text/javascript'],
  'gestures.js': ['mobile/android/web/gestures.js', 'text/javascript'],
  'composer.js': ['mobile/android/web/composer.js', 'text/javascript'],
  'terminalHistory.js': ['mobile/android/web/terminalHistory.js', 'text/javascript'],
  'terminalSelection.js': ['mobile/android/web/terminalSelection.js', 'text/javascript'],
  'connectionLatency.js': ['mobile/android/web/connectionLatency.js', 'text/javascript'],
  'workspaceState.js': ['mobile/android/web/workspaceState.js', 'text/javascript'],
  'app.css': ['mobile/android/web/app.css', 'text/css'],
  'xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  'xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  'fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  'jsqr.js': ['node_modules/jsqr/dist/jsQR.js', 'text/javascript'],
  'qingcode-icon.png': ['src-tauri/icons/128x128@2x.png', 'image/png'],
}

// A separate dev server keeps fixtures and memory adapters out of the desktop build.
export default defineConfig({
  cacheDir: '.dev/vite-web-test-cache',
  optimizeDeps: { entries: ['web-tests/index.html', 'web-tests/ssh-repair.html', 'web-tests/ssh-warmup.html', 'web-tests/ui-clarity.html', 'web-tests/terminal-exit.html', 'web-tests/app-close.html', 'web-tests/direct-agent.html', 'web-tests/ssh-server-recovery.html', 'web-tests/remote-connections.html', 'web-tests/scm-branches.html'] },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'qingcode-web-test-page',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const match = /^\/mobile-android\/([^?]*)/.exec(request.url ?? '')
          if (!match) return next()
          const name = match[1] || 'index.html'
          const send = async () => {
            if (name === 'index.html') {
              const html = await readFile(resolve(import.meta.dirname, 'mobile/android/web/index.html'), 'utf8')
              response.setHeader('content-type', 'text/html; charset=utf-8')
              response.end(html.replace('<head>', '<head>\n  <script src="/web-tests/mobile-android-bridge.js"></script>'))
              return
            }
            const asset = mobileAssets[name]
            if (!asset) {
              response.statusCode = 404
              response.end()
              return
            }
            response.setHeader('content-type', asset[1])
            response.end(await readFile(resolve(import.meta.dirname, asset[0])))
          }
          send().catch(next)
        })
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/' || request.url?.startsWith('/?')) {
            request.url = `/web-tests/index.html${request.url.slice(1)}`
          }
          next()
        })
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
    watch: { ignored: ['**/.dev/**', '**/src-tauri/**', '**/dist/**', '**/release/**'] },
  },
})
