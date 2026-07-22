import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Progressive baseline: logic helpers first; stores/components later.
      include: ['src/lib/**/*.ts', 'src/utils/**/*.ts'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/lib/**/*.d.ts',
        // Heavy UI-adjacent modules measured elsewhere / hard to unit-cover here.
        'src/lib/minimapPaint.ts',
        'src/lib/minimapBridge.ts',
        'src/lib/editorBasicSetup.ts',
        'src/lib/editorSettingsExtensions.ts',
        'src/lib/materialForestTheme.ts',
        'src/lib/appIconSvg.ts',
      ],
      // Floors sit just under the current lib+utils baseline (~40%) so regressions fail CI.
      thresholds: {
        lines: 40,
        functions: 35,
        branches: 35,
        statements: 38,
      },
    },
  },
})
