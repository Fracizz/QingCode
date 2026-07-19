import type { Extension } from '@codemirror/state'
import type { LanguageSupport } from '@codemirror/language'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'

type LanguageFactory = () => LanguageSupport

const SYNC_LANG_FACTORIES: Record<string, LanguageFactory> = {
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  // JSON5 / JSONC: JS highlighter so // and /* */ comments are allowed visually
  json5: () => javascript(),
  markdown: () => markdown(),
  css: () => css(),
  html: () => html(),
  python: () => python(),
}

const LAZY_LANG_LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  java: async () => {
    const { java } = await import('@codemirror/lang-java')
    return java()
  },
}

/** Whether a tab language id has a CodeMirror highlighter (sync or lazy). */
export function isSupportedEditorLanguage(languageId: string | undefined): boolean {
  if (!languageId || languageId === 'plain') return false
  return languageId in SYNC_LANG_FACTORIES || languageId in LAZY_LANG_LOADERS
}

/** Synchronous highlighter for bundled language packs only. */
export function languageSupportForId(languageId: string | undefined): Extension {
  if (!languageId) return []
  const factory = SYNC_LANG_FACTORIES[languageId]
  return factory ? factory() : []
}

/** Load a highlighter, dynamically importing heavier packs (e.g. Java). */
export async function loadLanguageSupport(languageId: string | undefined): Promise<Extension> {
  if (!languageId || languageId === 'plain') return []
  const lazy = LAZY_LANG_LOADERS[languageId]
  if (lazy) return lazy()
  return languageSupportForId(languageId)
}
