import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const webRoot = dirname(fileURLToPath(import.meta.url))
const desktopRequire = createRequire(resolve(webRoot, '../../desktop/package.json'))

// 终端与图标（xterm、lucide）和桌面共用同一份依赖，图标因此与电脑版一致；pnpm 隔离安装时从桌面包解析。
const terminalAliases = ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-unicode11', 'lucide-react']
  .map((name) => {
    const manifest = desktopRequire.resolve(`${name}/package.json`)
    const { module, main } = desktopRequire(manifest) as { module?: string; main: string }
    return { find: new RegExp(`^${name}$`), replacement: resolve(dirname(manifest), module ?? main) }
  })

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
  resolve: {
    // lucide 从桌面包解析，强制共用同一份 React，避免出现两份运行时。
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@xterm/xterm/css/xterm.css', replacement: desktopRequire.resolve('@xterm/xterm/css/xterm.css') },
      ...terminalAliases,
    ],
  },
  build: {
    outDir: resolve(webRoot, '../android/assets/web'),
    emptyOutDir: true,
    target: 'es2022',
  },
})
