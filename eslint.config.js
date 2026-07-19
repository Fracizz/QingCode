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
      'release',
      'src-tauri',
      'node_modules',
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
    },
    settings: {
      react: { version: 'detect' },
    },
  },
)
