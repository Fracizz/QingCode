import { useEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { Spinner } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSetting } from '../../settings/settingsStore'
import { mergeExtensions } from './extensions'
import { loadLanguageForPath } from './languages'

type Props = {
  /** 左/旧版本文本 */
  original: string
  /** 右/新版本文本（初始） */
  modified: string
  path: string
  layout: 'side' | 'unified'
  /** 右侧是否可编辑（冲突合并时作为结果） */
  editableB?: boolean
  /** 逐块采纳方向；a-to-b 表示把左侧内容搬到右侧 */
  revertControls?: 'a-to-b' | 'b-to-a'
  onModifiedChange?: (text: string) => void
  className?: string
}

/** 差异/冲突合并视图：并排 MergeView 与 unifiedMergeView 可切换；切换时保留右侧已编辑内容。 */
export function MergeEditor({
  original,
  modified,
  path,
  layout,
  editableB = false,
  revertControls,
  onModifiedChange,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const views = useRef<EditorView[]>([])
  const fontSize = useSetting((settings) => settings.general.editorFontSize)
  const current = useRef(modified)
  const originalRef = useRef(original)
  const changeRef = useRef(onModifiedChange)
  changeRef.current = onModifiedChange
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    let merge: MergeView | null = null
    let view: EditorView | null = null
    setLoading(true)

    void loadLanguageForPath(path).then((language) => {
      const host = hostRef.current
      if (!alive || !host) return
      const onChange = (text: string): void => {
        current.current = text
        changeRef.current?.(text)
      }
      if (layout === 'side') {
        merge = new MergeView({
          a: { doc: originalRef.current, extensions: mergeExtensions({ readOnly: true, language }) },
          b: {
            doc: current.current,
            extensions: mergeExtensions({ readOnly: !editableB, language, ...(editableB ? { onChange } : {}) }),
          },
          parent: host,
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 8 },
          ...(revertControls ? { revertControls } : {}),
        })
        // .cm-mergeView 是编辑器的祖先，主题里的 scoped 选择器够不到它；高度必须直接给，否则外层无法滚动。
        merge.dom.style.height = '100%'
        views.current = [merge.a, merge.b]
      } else {
        view = new EditorView({
          doc: current.current,
          extensions: [
            ...mergeExtensions({ readOnly: true, language }),
            unifiedMergeView({ original: originalRef.current, mergeControls: false, highlightChanges: true }),
          ],
          parent: host,
        })
        views.current = [view]
      }
      setLoading(false)
    })

    return () => {
      alive = false
      views.current = []
      merge?.destroy()
      view?.destroy()
    }
  }, [layout, path, editableB, revertControls])

  useEffect(() => {
    for (const view of views.current) view.requestMeasure()
  }, [fontSize])

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div ref={hostRef} className="h-full min-h-0 overflow-hidden bg-qn-code" />
      {loading && (
        <div className="absolute inset-0 grid place-items-center bg-qn-code">
          <Spinner label="加载差异…" />
        </div>
      )}
    </div>
  )
}
