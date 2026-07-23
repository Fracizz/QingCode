import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'

/** All language packs load on demand so the editor vendor chunk stays lean. */
const LAZY_LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  javascript: async () => {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript()
  },
  typescript: async () => {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript({ typescript: true })
  },
  jsx: async () => {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript({ jsx: true })
  },
  tsx: async () => {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript({ jsx: true, typescript: true })
  },
  json: async () => {
    const { json } = await import('@codemirror/lang-json')
    return json()
  },
  // JSON5 / JSONC: JS highlighter so // and /* */ comments are allowed visually
  json5: async () => {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript()
  },
  markdown: async () => {
    const { markdown } = await import('@codemirror/lang-markdown')
    return markdown()
  },
  css: async () => {
    const { css } = await import('@codemirror/lang-css')
    return css()
  },
  html: async () => {
    const { html } = await import('@codemirror/lang-html')
    return html()
  },
  python: async () => {
    const { python } = await import('@codemirror/lang-python')
    return python()
  },
  java: async () => {
    const { java } = await import('@codemirror/lang-java')
    return java()
  },
  yaml: async () => {
    const { yaml } = await import('@codemirror/lang-yaml')
    return yaml()
  },
  rust: async () => {
    const { rust } = await import('@codemirror/lang-rust')
    return rust()
  },
  go: async () => {
    const { go } = await import('@codemirror/lang-go')
    return go()
  },
  toml: async () => {
    const { toml } = await import('@codemirror/legacy-modes/mode/toml')
    return StreamLanguage.define(toml)
  },
  shell: async () => {
    const { shell } = await import('@codemirror/legacy-modes/mode/shell')
    return StreamLanguage.define(shell)
  },
}

/** Whether a tab language id has a CodeMirror highlighter. */
export function isSupportedEditorLanguage(languageId: string | undefined): boolean {
  if (!languageId || languageId === 'plain') return false
  return languageId in LAZY_LANG_LOADERS
}

/**
 * Synchronous highlighter stub — language packs are async-only now.
 * Prefer `loadLanguageSupport`. Kept so call sites / tests keep a stable API.
 */
export function languageSupportForId(_languageId?: string): Extension {
  return []
}

/** Load a highlighter, dynamically importing the matching language pack. */
export async function loadLanguageSupport(languageId: string | undefined): Promise<Extension> {
  if (!languageId || languageId === 'plain') return []
  const lazy = LAZY_LANG_LOADERS[languageId]
  return lazy ? lazy() : []
}
