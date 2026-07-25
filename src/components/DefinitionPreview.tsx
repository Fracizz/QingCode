import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  GitFork,
  LoaderCircle,
  Pin,
  PinOff,
} from 'lucide-react'
import { jumpToDefinitionCandidate } from '../lib/definitionNavigation'
import { useI18n } from '../lib/i18n'
import { useDefinitionPreviewStore } from '../store/definitionPreviewStore'
import { getContextMenuStylePosition } from './contextMenuPosition'
import Tooltip from './Tooltip'

function kindLabel(kind: string): string {
  switch (kind.toLowerCase()) {
    case 'function':
      return '函数'
    case 'method':
      return '方法'
    case 'class':
      return '类'
    case 'interface':
      return '接口'
    case 'module':
      return '模块'
    case 'struct':
      return '结构体'
    case 'trait':
      return '特征'
    case 'enum':
      return '枚举'
    case 'variable':
      return '变量'
    case 'parameter':
      return '参数'
    case 'constant':
      return '常量'
    case 'field':
      return '字段'
    case 'import':
      return '导入'
    default:
      return '符号'
  }
}

export default function DefinitionPreview() {
  const { t } = useI18n()
  const open = useDefinitionPreviewStore(state => state.open)
  const loading = useDefinitionPreviewStore(state => state.loading)
  const pinned = useDefinitionPreviewStore(state => state.pinned)
  const requestId = useDefinitionPreviewStore(state => state.requestId)
  const symbol = useDefinitionPreviewStore(state => state.symbol)
  const anchor = useDefinitionPreviewStore(state => state.anchor)
  const candidates = useDefinitionPreviewStore(state => state.candidates)
  const onFindUsages = useDefinitionPreviewStore(state => state.onFindUsages)
  const closePreview = useDefinitionPreviewStore(state => state.closePreview)
  const setPinned = useDefinitionPreviewStore(state => state.setPinned)
  const setPointerInside = useDefinitionPreviewStore(state => state.setPointerInside)
  const shellRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState({ x: 8, y: 8 })

  useEffect(() => {
    queueMicrotask(() => setActiveIndex(0))
  }, [requestId])

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!open || !anchor || !shell) return
    const zoom = Number.parseFloat(getComputedStyle(shell).zoom) || 1
    const preferAbove = window.innerHeight - anchor.bottom < Math.min(260, shell.offsetHeight + 16)
    const placed = getContextMenuStylePosition(
      anchor.left,
      preferAbove ? anchor.top : anchor.bottom + 6,
      { width: shell.offsetWidth, height: shell.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      preferAbove,
      zoom,
      { arrowGap: preferAbove ? 6 : 0 }
    )
    setPosition({ x: placed.x, y: placed.y })
  }, [activeIndex, anchor, candidates, loading, open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = () => closePreview(true)
    const onBlur = () => closePreview(true)
    const onResize = () => closePreview(true)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePreview(true)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [closePreview, open])

  if (!open || !anchor) return null

  const candidate = candidates[Math.min(activeIndex, Math.max(0, candidates.length - 1))]
  const choose = async () => {
    if (!candidate) return
    closePreview(true)
    await jumpToDefinitionCandidate(candidate)
  }
  const findUsages = async () => {
    if (!onFindUsages) return
    closePreview(true)
    await onFindUsages()
  }

  return createPortal(
    <div
      ref={shellRef}
      role="dialog"
      aria-label={t('「{symbol}」的定义预览', { symbol })}
      className="menu-enter ui-font-scaled fixed z-[124] w-[min(520px,calc(100vw-16px))] overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      style={{ left: position.x, top: position.y }}
      onPointerDown={event => event.stopPropagation()}
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => {
        setPointerInside(false)
        const state = useDefinitionPreviewStore.getState()
        if (!state.modifierHeld && !state.pinned) state.closePreview()
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileCode2 size={15} className="flex-shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{symbol}</span>
        {candidate && (
          <span className="text-[11px] text-fg-muted">{t(kindLabel(candidate.kind))}</span>
        )}
        {candidates.length > 1 && (
          <span className="text-[11px] tabular-nums text-fg-dim">
            {Math.min(activeIndex + 1, candidates.length)} / {candidates.length}
          </span>
        )}
        <Tooltip label={pinned ? t('取消固定') : t('固定预览')} side="bottom">
          <button
            type="button"
            aria-label={pinned ? t('取消固定') : t('固定预览')}
            aria-pressed={pinned}
            className={`rounded p-1 transition-colors ${
              pinned ? 'bg-bg-active text-accent' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
            }`}
            onClick={() => setPinned(!pinned)}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </Tooltip>
      </div>

      <div className="min-h-[84px] px-3 py-2.5">
        {loading && !candidate ? (
          <div className="flex min-h-[64px] items-center justify-center gap-2 text-[12px] text-fg-muted">
            <LoaderCircle size={15} className="animate-spin" aria-hidden />
            {t('正在解析定义…')}
          </div>
        ) : candidate ? (
          <>
            <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-fg-muted">
              <span className="min-w-0 flex-1 truncate">{candidate.relative}</span>
              <span className="flex-shrink-0">
                :{candidate.line}:{candidate.column}
              </span>
              {candidate.approximate && (
                <span className="flex-shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-warn">
                  {t('近似')}
                </span>
              )}
            </div>
            <pre className="mt-2 max-h-[112px] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg px-2.5 py-2 font-mono text-[12px] leading-5 text-fg">
              {candidate.text || symbol}
            </pre>
          </>
        ) : (
          <div className="flex min-h-[64px] items-center justify-center text-[12px] text-fg-dim">
            {t('未找到「{symbol}」的定义', { symbol })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border bg-bg px-2.5 py-2">
        {candidates.length > 1 && (
          <>
            <Tooltip label={t('上一个定义')} side="top">
              <button
                type="button"
                aria-label={t('上一个定义')}
                className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
                onClick={() =>
                  setActiveIndex(index => (index - 1 + candidates.length) % candidates.length)
                }
              >
                <ChevronLeft size={14} />
              </button>
            </Tooltip>
            <Tooltip label={t('下一个定义')} side="top">
              <button
                type="button"
                aria-label={t('下一个定义')}
                className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
                onClick={() => setActiveIndex(index => (index + 1) % candidates.length)}
              >
                <ChevronRight size={14} />
              </button>
            </Tooltip>
          </>
        )}
        <span className="ml-auto" />
        {onFindUsages && (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg"
            onClick={() => void findUsages()}
          >
            <GitFork size={13} aria-hidden />
            {t('查找用法')}
          </button>
        )}
        <button
          type="button"
          disabled={!candidate}
          className="flex items-center gap-1.5 rounded bg-accent/90 px-2.5 py-1.5 text-[11px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
          onClick={() => void choose()}
        >
          {t('跳转到定义')}
          <ArrowRight size={13} aria-hidden />
        </button>
      </div>
    </div>,
    document.body
  )
}
