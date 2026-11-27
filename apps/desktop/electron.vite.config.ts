import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

// 开发态由 vite dev server 注入 HMR 脚本，严格 CSP 会阻断；生产态保持 index.html 里的 CSP。
const devCspPlugin = (): Plugin => ({
  name: 'qn-dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta http-equiv="Content-Security-Policy" content="[^"]*"/,
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' \'unsafe-inline\' data: blob:; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\' ws: wss: http://localhost:*"'
    )
  },
})

const r = (p: string) => resolve(__dirname, p)

export default defineConfig({
  main: {
    build: {
      // 工作区包是 TS 源码必须打进产物，ssh2 及其子路径保持 external。
      externalizeDeps: { exclude: ['@qn/protocol', '@qn/codex-client'] },
      rolldownOptions: {
        input: {
          index: r('src/main/index.ts'),
          backend: r('src/backend/index.ts'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  },
  preload: {
    build: {
      // sandbox:true 的 preload 只能是 CJS，用 .cjs 后缀避免 package.json 的 type:module 影响。
      rolldownOptions: {
        input: { index: r('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), devCspPlugin()],
    server: process.env['QN_DEV_HOST'] ? { host: process.env['QN_DEV_HOST'] } : {},
  },
})
