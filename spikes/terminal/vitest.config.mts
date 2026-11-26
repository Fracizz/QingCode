import { defineConfig } from 'vitest/config'

// 根 vitest.config.ts 的 include 只覆盖 packages/ 与 apps/，spike 自带一份配置。
export default defineConfig({
  test: {
    include: ['spikes/terminal/*.test.ts'],
    environment: 'node',
  },
})
