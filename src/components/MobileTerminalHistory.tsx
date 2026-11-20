import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useI18n } from '../lib/i18n'
import {
  previewMobileSession,
  readMobileSessionHistory,
  type MobileSessionPreview,
} from '../lib/ipc/mobileSessions'

interface Props {
  id: string
  initialPreview?: MobileSessionPreview
  startAtTop?: boolean
  scrollUp?: number
  style?: CSSProperties
  onReturn: () => void
}

/** 终端标签和只读预览共用的历史视图。进入时固定画面与游标，实时输出留在原视图。 */
export default function MobileTerminalHistory(props: Props) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<MobileSessionPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const returnButton = useRef<HTMLButtonElement>(null)
  const { id, initialPreview, onReturn } = props

  useLayoutEffect(() => {
    if (!initialPreview) returnButton.current?.focus({ preventScroll: true })
  }, [initialPreview])

  useEffect(() => {
    if (initialPreview) return
    let cancelled = false
    void previewMobileSession(id).then(
      next => { if (!cancelled) setLoaded(next) },
      cause => { if (!cancelled) setError(String(cause)) },
    )
    return () => { cancelled = true }
  }, [attempt, id, initialPreview])

  const preview = initialPreview ?? loaded
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-terminal text-fg"
      onMouseDown={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-dialog-separator bg-dialog-chrome px-3 py-1.5 text-ui-sm">
        <span className="font-medium">{t('终端历史')}</span>
        <button ref={returnButton} type="button" onClick={onReturn} className="rounded px-2 py-0.5 text-accent hover:bg-bg-hover">
          {t('回到最新')}
        </button>
      </header>
      {preview ? <HistoryPages {...props} preview={preview} /> : (
        <div className="p-3 text-ui-sm text-fg-muted" role={error ? 'alert' : 'status'}>
          {error ? t('读取终端历史失败：{error}', { error }) : t('正在加载历史…')}
          {error && <button type="button" className="ml-2 rounded px-2 py-0.5 text-accent hover:bg-bg-hover" onClick={() => {
            setError(null)
            setAttempt(value => value + 1)
          }}>{t('重试')}</button>}
        </div>
      )}
    </div>
  )
}

function HistoryPages({ id, preview, startAtTop, scrollUp = 0, style, onReturn }: Props & { preview: MobileSessionPreview }) {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef(false)
  const leftBottom = useRef(false)
  const before = useRef(preview.historyMore ? preview.historyBefore : null)
  const prependAt = useRef<{ height: number; top: number } | null>(null)
  const [pages, setPages] = useState<{ before: number; lines: string[] }[]>([])
  const [more, setMore] = useState(preview.historyMore && preview.historyBefore !== null)
  const [truncated, setTruncated] = useState(preview.historyTruncated)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadOlder = useCallback(async () => {
    const cursor = before.current
    const scroll = scrollRef.current
    if (cursor === null || pending.current || !scroll) return
    pending.current = true
    setError(null)
    setLoading(true)
    try {
      const page = await readMobileSessionHistory(id, cursor)
      if (scrollRef.current !== scroll) return
      before.current = page.more && page.before < cursor ? page.before : null
      if (page.lines.length > 0) {
        prependAt.current = { height: scroll.scrollHeight, top: scroll.scrollTop }
        setPages(current => [{ before: cursor, lines: page.lines }, ...current])
      }
      setMore(before.current !== null)
      setTruncated(page.truncated)
    } catch (cause) {
      if (scrollRef.current === scroll) setError(String(cause))
    } finally {
      pending.current = false
      if (scrollRef.current === scroll) setLoading(false)
    }
  }, [id])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTop = startAtTop ? 0 : scroll.scrollHeight - scroll.clientHeight - scrollUp
    scroll.focus({ preventScroll: true })
    if (!startAtTop && !preview.alternate) return
    const frame = requestAnimationFrame(() => { void loadOlder() })
    return () => cancelAnimationFrame(frame)
  }, [loadOlder, preview.alternate, scrollUp, startAtTop])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const anchor = prependAt.current
    if (!scroll || !anchor) return
    prependAt.current = null
    scroll.scrollTop = anchor.top + scroll.scrollHeight - anchor.height
  }, [pages])

  const prefetch = (scroll: HTMLDivElement) => {
    if (!more || error || scroll.scrollTop > 48) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && scroll.contains(selection.anchorNode)) return
    void loadOlder()
  }
  const screen = preview.alternate ? preview.screen : preview.screen.replace(/\n+$/, '')
  const historyClass = 'm-0 whitespace-pre-wrap [overflow-wrap:anywhere]'
  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={t('终端历史')}
      tabIndex={0}
      onScroll={event => {
        const scroll = event.currentTarget
        const fromBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
        if (fromBottom > 24) leftBottom.current = true
        if (leftBottom.current && fromBottom <= 2 && !pending.current) {
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || !scroll.contains(selection.anchorNode)) onReturn()
          return
        }
        prefetch(scroll)
      }}
      onWheel={event => {
        if (event.deltaY < 0 && !event.ctrlKey && !event.metaKey) prefetch(event.currentTarget)
      }}
      style={style}
      className="min-h-0 flex-1 select-text overflow-auto px-3 py-2 font-mono text-ui leading-[1.45] [overflow-anchor:none]"
    >
      {more ? (
        <div className="mb-2 text-ui-sm">
          {error && <p role="alert" className="text-danger">{t('读取终端历史失败：{error}', { error })}</p>}
          <button type="button" disabled={loading} onClick={() => void loadOlder()}
            className="btn btn-secondary btn-sm">
            {loading ? t('正在加载历史…') : error ? t('重试') : t('加载更早输出')}
          </button>
        </div>
      ) : (
        <div className="mb-2 text-ui-sm text-fg-muted">
          {truncated ? t('更早输出已超出缓存') : t('已到保留历史起点')}
        </div>
      )}
      {pages.map(page => <pre key={page.before} className={historyClass}>{page.lines.join('\n')}{'\n'}</pre>)}
      {preview.history.length > 0 && <pre className={historyClass}>{preview.history.join('\n')}{'\n'}</pre>}
      <pre className="m-0 whitespace-pre">{screen || (preview.history.length === 0 && t('（暂无输出）'))}</pre>
    </div>
  )
}
