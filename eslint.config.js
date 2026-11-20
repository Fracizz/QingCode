import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import react from 'eslint-plugin-react'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'release',
      'src-tauri',
      'node_modules',
      '.dev',
      '*.config.js',
      '*.config.ts',
      'vite-env.d.ts',
      // Tests are excluded from tsconfig; type-aware lint cannot parse them.
      '**/*.{test,spec}.{ts,tsx}',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.node.json'],
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      react,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler–oriented hooks rules flag intentional desktop UI patterns
      // (lazy init, body cursor during drag, dynamic lucide icons). Warn until migrated.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/static-components': 'warn',
      'no-useless-assignment': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      // Empty catch blocks are common for quota / private-mode storage.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Terminal OSC / ANSI parsers legitimately match control characters.
      'no-control-regex': 'off',
      // Ban browser-native tooltips; use shared Tooltip (see DESIGN.md).
      'react/forbid-dom-props': ['error', { forbid: ['title'] }],
      // 控件基准（DESIGN.md「控件基准」）：字号走 text-ui-* token，圆角只用 4 / 6 / 8 三档，
      // 图标 size 只用 12 / 14 / 16（展示图标 22 / 28 除外）。
      'no-restricted-syntax': [
        'error',
        ...['Literal[value', 'TemplateElement[value.raw'].flatMap(node => [
          {
            selector: `${node}=/(^|[\\s:])text-\\[\\d+(\\.\\d+)?px\\]/]`,
            message: '字号使用 text-ui-* token，不写固定像素（DESIGN.md「字号层级」）。',
          },
          {
            selector: `${node}=/(^|[\\s:])rounded(-[trblse]{1,2})?-\\[\\d+(\\.\\d+)?px\\]/]`,
            message: '圆角只用 rounded（4px）/ rounded-md（6px）/ rounded-lg（8px）三档（DESIGN.md「控件基准」）。',
          },
        ]),
        {
          selector:
            'JSXAttribute[name.name="size"] > JSXExpressionContainer > Literal:matches([value=10], [value=11], [value=13], [value=15], [value=17], [value=18], [value=20])',
          message: '图标尺寸只用 12 / 14 / 16，展示图标用 22 / 28（DESIGN.md「控件基准」）。',
        },
      ],
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    // QingCode Android WebView assets: plain browser modules bundled into the APK.
    extends: [js.configs.recommended],
    files: ['mobile/android/web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  }
)
