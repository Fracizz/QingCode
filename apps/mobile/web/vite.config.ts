import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const webRoot = dirname(fileURLToPath(import.meta.url))

// T12 用 shouldInterceptRequest 直接喂本地资源，响应里没有 CORS 头；去掉 crossorigin 避免真机上被 CORS 拦下。
const stripCrossOrigin = (): Plugin => ({
  name: 'qn-strip-crossorigin',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html: string): string {
      return html.replace(/\s+crossorigin(?:="[^"]*")?/g, '')
    },
  },
})

export default defineConfig({
  root: webRoot,
  // APK 里页面从 assets/web/index.html 加载，资源必须走相对路径。
  base: './',
  plugins: [react(), tailwindcss(), stripCrossOrigin()],
  build: {
    outDir: resolve(webRoot, '../android/assets/web'),
    emptyOutDir: true,
    target: 'es2022',
  },
})
