import { useEffect, useRef, useState, useCallback } from 'react'
import { MergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react'
import type { EditorTab } from '../types'
import { loadLanguageSupport } from '../lib/editorLanguages'
import { FONT_SETTINGS_EVENT } from '../lib/fontSettings'
import { getResolvedTheme, THEME_SETTINGS_EVENT } from '../lib/themeSettings'
import { FOREST_THEME, forestSyntax } from '../lib/forestEditorTheme'
import { translateFor, useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

/** 差异对比文件大小上限：超过此值的文件不显示差异对比（5MB） */
const DIFF_MAX_BYTES = 5 * 1024 * 1024

/* ------------------------------------------------------------------ */
/*  高对比度差异主题（覆盖 CodeMirror merge 的默认低对比度颜色）          */
/*  &light / &dark 只能用在 baseTheme，不能用在 EditorView.theme。       */
/* ------------------------------------------------------------------ */
const diffTheme = EditorView.baseTheme({
  /* 左侧（HEAD）删除行背景 — soft wash, no neon borders */
  '&.cm-merge-a .cm-changedLine, & .cm-deletedChunk': {
    backgroundColor: 'rgba(244, 135, 113, 0.14)',
  },
  /* 右侧（工作区）新增行背景 */
  '&.cm-merge-b .cm-changedLine, & .cm-inlineChangedLine': {
    backgroundColor: 'rgba(137, 209, 133, 0.14)',
  },
  /*
   * Inline change marks: solid translucent fill instead of CM's default
   * bottom-gradient "underline", which wraps into thin bright vertical boxes
   * when line wrapping / font scaling is on.
   */
  '&light.cm-merge-a .cm-changedText, &light .cm-deletedChunk .cm-deletedText': {
    background: 'rgba(196, 30, 58, 0.22)',
    padding: '0 1px',
    borderRadius: '2px',
  },
  '&dark.cm-merge-a .cm-changedText, &dark .cm-deletedChunk .cm-deletedText': {
    background: 'rgba(244, 135, 113, 0.28)',
    padding: '0 1px',
    borderRadius: '2px',
  },
  '&light.cm-merge-b .cm-changedText': {
    background: 'rgba(16, 124, 16, 0.20)',
    padding: '0 1px',
    borderRadius: '2px',
  },
  '&dark.cm-merge-b .cm-changedText': {
    background: 'rgba(137, 209, 133, 0.28)',
    padding: '0 1px',
    borderRadius: '2px',
  },
  /* Narrow gutter ticks aligned with --color-danger / --color-ok */
  '&light.cm-merge-a .cm-changedLineGutter, &light .cm-deletedLineGutter': {
    background: 'color-mix(in srgb, var(--color-danger) 85%, transparent)',
  },
  '&dark.cm-merge-a .cm-changedLineGutter, &dark .cm-deletedLineGutter': {
    background: 'color-mix(in srgb, var(--color-danger) 75%, transparent)',
  },
  '&light.cm-merge-b .cm-changedLineGutter': {
    background: 'color-mix(in srgb, var(--color-ok) 85%, transparent)',
  },
  '&dark.cm-merge-b .cm-changedLineGutter': {
    background: 'color-mix(in srgb, var(--color-ok) 75%, transparent)',
  },
})

/* Colors only — MergeView forces editor/scroller height:auto + overflow visible
   so both panes grow together; scrolling is on `.cm-mergeView` (merge-diff.css). */
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#f0f0f0', color: '#1f1f1f' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg)',
      color: 'var(--color-fg-muted)',
      borderRight: 'none',
    },
  },
  { dark: false },
)

const darkTheme = [oneDark]

const forestTheme = [FOREST_THEME, forestSyntax]

function editorThemeExtension() {
  const resolved = getResolvedTheme()
  if (resolved === 'forest') return forestTheme
  if (resolved === 'dark') return darkTheme
  return lightTheme
}

/** CodeMirror merge collapse marker; `$` is replaced by the line count via `EditorState.phrase`. */
const COLLAPSE_UNCHANGED_PHRASE = '$ unchanged lines'

function sideExtensions(lang: Extension, collapseUnchangedLabel: string) {
  return [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    editorThemeExtension(),
    diffTheme,
    EditorState.phrases.of({ [COLLAPSE_UNCHANGED_PHRASE]: collapseUnchangedLabel }),
    lang,
  ]
}

/** 统计文本中的新增/删除行数（基于换行符） */
function countDiffLines(original: string, current: string): { added: number; removed: number } {
  const origLines = original.split('\n')
  const currLines = current.split('\n')
  let added = 0
  let removed = 0
  const maxLen = Math.max(origLines.length, currLines.length)
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] ?? ''
    const c = currLines[i] ?? ''
    if (o !== c) {
      if (o && !c) removed++
      else if (!o && c) added++
      else {
        /* 修改行：两边都计 */
        added++
        removed++
      }
    }
  }
  return { added, removed }
}

type Props = {
  tab: EditorTab
}

/** Read-only side-by-side compare: HEAD (left) ↔ working tree (right). */
export default function DiffEditor({ tab }: Props) {
  const { t, language } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeView | null>(null)
  const [stats, setStats] = useState({ added: 0, removed: 0 })

  // 计算内容大小，超过阈值时禁用差异对比
  const contentSize = (tab.originalContent?.length ?? 0) + (tab.content?.length ?? 0)
  const isTooLarge = contentSize > DIFF_MAX_BYTES

  const buildMergeView = useCallback(async (parent: HTMLElement) => {
    // `@codemirror/merge` renders collapses via phrase("$ unchanged lines", n).
    const collapseUnchangedLabel = translateFor(language, '$ 行未更改')
    const lang = await loadLanguageSupport(tab.language)
    if (!hostRef.current || hostRef.current !== parent) return
    mergeRef.current?.destroy()
    mergeRef.current = new MergeView({
      a: {
        doc: tab.originalContent ?? '',
        extensions: sideExtensions(lang, collapseUnchangedLabel),
      },
      b: {
        doc: tab.content ?? '',
        extensions: [
          ...sideExtensions(lang, collapseUnchangedLabel),
          keymap.of([
            { key: 'Mod-ArrowDown', run: goToNextChunk },
            { key: 'Mod-ArrowUp', run: goToPreviousChunk },
          ]),
        ],
      },
      parent,
      collapseUnchanged: { margin: 3, minSize: 4 },
      gutter: true,
      highlightChanges: true,
    })
  }, [tab.originalContent, tab.content, tab.language, language])

  useEffect(() => {
    if (!hostRef.current || isTooLarge) return
    let cancelled = false
    const parent = hostRef.current

    void buildMergeView(parent).then(() => {
      if (cancelled) return
      setStats(countDiffLines(tab.originalContent ?? '', tab.content ?? ''))
    })

    const rebuild = () => {
      const host = hostRef.current
      if (!host) return
      void buildMergeView(host).then(() => {
        if (cancelled) return
        mergeRef.current?.a.requestMeasure()
        mergeRef.current?.b.requestMeasure()
      })
    }
    window.addEventListener(THEME_SETTINGS_EVENT, rebuild)
    window.addEventListener(FONT_SETTINGS_EVENT, rebuild)
    return () => {
      cancelled = true
      window.removeEventListener(THEME_SETTINGS_EVENT, rebuild)
      window.removeEventListener(FONT_SETTINGS_EVENT, rebuild)
      mergeRef.current?.destroy()
      mergeRef.current = null
    }
  }, [tab.id, tab.originalContent, tab.content, tab.language, language, buildMergeView, isTooLarge])

  const handlePrevDiff = useCallback(() => {
    const b = mergeRef.current?.b
    if (!b) return
    goToPreviousChunk({ state: b.state, dispatch: b.dispatch.bind(b) })
  }, [])

  const handleNextDiff = useCallback(() => {
    const b = mergeRef.current?.b
    if (!b) return
    goToNextChunk({ state: b.state, dispatch: b.dispatch.bind(b) })
  }, [])

  // 文件过大时显示提示，不渲染差异对比
  if (isTooLarge) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
        <div className="ui-font-scaled flex flex-shrink-0 border-b border-border text-[11px]">
          <div className="flex flex-1 items-center border-r border-border px-3 py-1.5 text-fg-muted">
            <span className="truncate">{t('HEAD（原文件）')}</span>
          </div>
          <div className="flex flex-1 items-center px-3 py-1.5 text-fg-muted">
            <span className="truncate">{t('工作区（当前）')}</span>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex flex-col items-center gap-3 text-fg-muted">
            <AlertTriangle size={32} className="text-warn" />
            <p className="text-sm font-medium">{t('文件过大，无法显示差异对比')}</p>
            <p className="text-xs">
              {t('差异对比支持的最大文件大小为 {size}', { size: '5MB' })}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
      {/* Header: 文件信息 + 差异统计 + 导航 */}
      <div className="ui-font-scaled flex flex-shrink-0 border-b border-border text-[11px]">
        <div className="flex flex-1 items-center border-r border-border px-3 py-1.5 text-fg-muted">
          <span className="truncate">{t('HEAD（原文件）')}</span>
          {stats.removed > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
              -{stats.removed}
            </span>
          )}
        </div>
        <div className="flex flex-1 items-center px-3 py-1.5 text-fg-muted">
          <span className="truncate">{t('工作区（当前）')}</span>
          {stats.added > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
              +{stats.added}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Tooltip label={t('上一个差异')} side="bottom">
              <button
                type="button"
                onClick={handlePrevDiff}
                aria-label={t('上一个差异')}
                className="flex h-5 w-5 items-center justify-center rounded hover:bg-bg-deep"
              >
                <ChevronUp size={12} />
              </button>
            </Tooltip>
            <Tooltip label={t('下一个差异')} side="bottom">
              <button
                type="button"
                onClick={handleNextDiff}
                aria-label={t('下一个差异')}
                className="flex h-5 w-5 items-center justify-center rounded hover:bg-bg-deep"
              >
                <ChevronDown size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {/* Scroll lives on `.cm-mergeView` (see merge-diff.css), not per-pane `.cm-scroller`. */}
      <div ref={hostRef} className="cm-merge-host min-h-0 flex-1" />
    </div>
  )
}
