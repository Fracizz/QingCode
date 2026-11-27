import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'apps/mobile/web/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
