import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 手机端的 lucide-react 与桌面共用一份（见 apps/mobile/web/vite.config.ts）；pnpm 隔离安装时
// 手机包下没有它，单测也要从桌面包解析，否则组件测试在导入阶段就失败。
const desktopRequire = createRequire(resolve(import.meta.dirname, 'apps/desktop/package.json'))
const lucide = resolve(dirname(desktopRequire.resolve('lucide-react/package.json')))

export default defineConfig({
  resolve: {
    alias: [{ find: /^lucide-react$/, replacement: lucide }],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'apps/mobile/web/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
