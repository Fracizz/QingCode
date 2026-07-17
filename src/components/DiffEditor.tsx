import { useEffect, useRef } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import type { EditorTab } from '../types'
import { getResolvedTheme, THEME_SETTINGS_EVENT } from '../lib/themeSettings'
import { FOREST_THEME, forestSyntax } from '../lib/forestEditorTheme'
import { useI18n } from '../lib/i18n'

const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#f0f0f0', color: '#1f1f1f', height: '100%' },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-gutters': { backgroundColor: '#ebebeb', color: '#757575', borderRight: '1px solid #d0d0d0' },
  },
  { dark: false },
)

const darkTheme = [
  oneDark,
  EditorView.theme({
    '&': { height: '100%' },
    '.cm-scroller': { overflow: 'auto' },
  }),
]

const forestTheme = [
  FOREST_THEME,
  forestSyntax,
  EditorView.theme({
    '&': { height: '100%' },
    '.cm-scroller': { overflow: 'auto' },
  }),
]

function editorThemeExtension() {
  const resolved = getResolvedTheme()
  if (resolved === 'forest') return forestTheme
  if (resolved === 'dark') return darkTheme
  return lightTheme
}

const LANG_MAP: Record<string, () => import('@codemirror/language').LanguageSupport> = {
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  json5: () => javascript(),
  markdown: () => markdown(),
  css: () => css(),
  html: () => html(),
  python: () => python(),
}

function sideExtensions(language?: string) {
  const lang = language ? LANG_MAP[language]?.() : undefined
  return [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    editorThemeExtension(),
    lang ?? [],
  ]
}

type Props = {
  tab: EditorTab
}

/** Read-only side-by-side compare: HEAD (left) ↔ working tree (right). */
export default function DiffEditor({ tab }: Props) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeView | null>(null)

  useEffect(() => {
    if (!hostRef.current) return

    mergeRef.current?.destroy()
    mergeRef.current = new MergeView({
      a: {
        doc: tab.originalContent ?? '',
        extensions: sideExtensions(tab.language),
      },
      b: {
        doc: tab.content ?? '',
        extensions: sideExtensions(tab.language),
      },
      parent: hostRef.current,
      collapseUnchanged: { margin: 3, minSize: 4 },
    })

    const onTheme = () => {
      // Rebuild so theme compartments stay in sync with app theme.
      const parent = hostRef.current
      if (!parent) return
      mergeRef.current?.destroy()
      mergeRef.current = new MergeView({
        a: {
          doc: tab.originalContent ?? '',
          extensions: sideExtensions(tab.language),
        },
        b: {
          doc: tab.content ?? '',
          extensions: sideExtensions(tab.language),
        },
        parent,
        collapseUnchanged: { margin: 3, minSize: 4 },
      })
    }
    window.addEventListener(THEME_SETTINGS_EVENT, onTheme)
    return () => {
      window.removeEventListener(THEME_SETTINGS_EVENT, onTheme)
      mergeRef.current?.destroy()
      mergeRef.current = null
    }
  }, [tab.id, tab.originalContent, tab.content, tab.language])

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="ui-font-scaled flex flex-shrink-0 border-b border-border text-[11px] text-fg-muted">
        <div className="flex-1 truncate border-r border-border px-3 py-1.5">{t('HEAD（原文件）')}</div>
        <div className="flex-1 truncate px-3 py-1.5">{t('工作区（当前）')}</div>
      </div>
      <div ref={hostRef} className="cm-merge-host min-h-0 flex-1 overflow-hidden" />
    </div>
  )
}
