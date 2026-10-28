import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// A separate dev server keeps fixtures and memory adapters out of the desktop build.
export default defineConfig({
  cacheDir: '.dev/vite-web-test-cache',
  optimizeDeps: { entries: ['web-tests/index.html', 'web-tests/ssh-repair.html', 'web-tests/ssh-warmup.html', 'web-tests/ssh-opening.html', 'web-tests/ui-clarity.html'] },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'qingcode-web-test-page',
      configureServer(server) {
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
        replacement: resolve(__dirname, 'src/test-pages/projectManagerAdapters.ts'),
      },
      { find: '@', replacement: resolve(__dirname, 'src') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 38439,
    strictPort: true,
    watch: { ignored: ['**/.dev/**', '**/src-tauri/**', '**/dist/**', '**/release/**'] },
  },
})
