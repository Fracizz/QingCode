import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  BookOpen,
  CircleHelp,
  FileCode2,
  Files,
  GitFork,
  List,
  Package,
  Pencil,
} from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { jumpToDefinitionCandidate, type DefinitionCandidate } from '../lib/definitionNavigation'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useI18n } from '../lib/i18n'
import type { SemanticUsageFilter } from '../lib/semanticNavigation'
import { getContextMenuStylePosition } from './contextMenuPosition'

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

function usageKindLabel(kind: DefinitionCandidate['usageKind']): string {
  switch (kind) {
    case 'call':
    case 'member-call':
      return '调用'
    case 'write':
    case 'member-write':
      return '写入'
    case 'read-write':
    case 'member-read-write':
      return '读写'
    case 'import':
      return '导入'
    case 'type':
      return '类型引用'
    case 'read':
    case 'member-read':
    default:
      return '读取'
  }
}

function matchesUsageFilter(candidate: DefinitionCandidate, filter: SemanticUsageFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'approximate') return Boolean(candidate.approximate)
  const kind = candidate.usageKind
  if (filter === 'read') return kind === 'read' || kind === 'member-read'
  if (filter === 'write') {
    return (
      kind === 'write' ||
      kind === 'member-write' ||
      kind === 'read-write' ||
      kind === 'member-read-write'
    )
  }
  if (filter === 'call') return kind === 'call' || kind === 'member-call'
  return kind === 'import'
}

function splitRelativePath(relative: string): { file: string; directory: string } {
  const normalized = relative.replace(/\\/gu, '/')
  const separator = normalized.lastIndexOf('/')
  if (separator < 0) return { file: normalized, directory: '' }
  return {
    file: normalized.slice(separator + 1),
    directory: normalized.slice(0, separator),
  }
}

function highlightedCode(text: string, symbol: string) {
  const index = text.indexOf(symbol)
  if (index < 0) return text
  return (
    <>
      {text.slice(0, index)}
      <span className="font-semibold text-accent">{symbol}</span>
      {text.slice(index + symbol.length)}
    </>
  )
}

export default function DefinitionPicker() {
  const { t } = useI18n()
  const open = useDefinitionPickerStore(state => state.open)
  const mode = useDefinitionPickerStore(state => state.mode)
  const symbol = useDefinitionPickerStore(state => state.symbol)
  const candidates = useDefinitionPickerStore(state => state.candidates)
  const details = useDefinitionPickerStore(state => state.details)
  const usageLoader = useDefinitionPickerStore(state => state.usageLoader)
  const closePicker = useDefinitionPickerStore(state => state.closePicker)
  const [activeIndex, setActiveIndex] = useState(0)
  const [usageFilter, setUsageFilter] = useState<SemanticUsageFilter>('all')
  const [pagedCandidates, setPagedCandidates] = useState(candidates)
  const [pagedDetails, setPagedDetails] = useState(details)
  const [loadingUsages, setLoadingUsages] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const usageRequestRef = useRef(0)
  const [pickerPosition, setPickerPosition] = useState({ x: 8, y: 8 })
  const filteredCandidates = useMemo(
    () =>
      mode === 'reference'
        ? usageLoader
          ? pagedCandidates
          : candidates.filter(candidate => matchesUsageFilter(candidate, usageFilter))
        : candidates,
    [candidates, mode, pagedCandidates, usageFilter, usageLoader]
  )

  useEffect(() => {
    if (!open) return
    usageRequestRef.current += 1
    queueMicrotask(() => {
      setActiveIndex(0)
      setUsageFilter('all')
      setPagedCandidates(candidates)
      setPagedDetails(details)
      setLoadingUsages(false)
    })
  }, [open, candidates, details])

  useEffect(() => {
    queueMicrotask(() => setActiveIndex(0))
  }, [usageFilter])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePicker()
      } else if (event.key === 'ArrowDown' && filteredCandidates.length > 0) {
        event.preventDefault()
        setActiveIndex(index => (index + 1) % filteredCandidates.length)
      } else if (event.key === 'ArrowUp' && filteredCandidates.length > 0) {
        event.preventDefault()
        setActiveIndex(index => (index - 1 + filteredCandidates.length) % filteredCandidates.length)
      } else if (event.key === 'Enter') {
        const candidate = filteredCandidates[activeIndex]
        if (!candidate) return
        event.preventDefault()
        closePicker()
        void jumpToDefinitionCandidate(candidate)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activeIndex, closePicker, filteredCandidates, open])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-def-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filteredCandidates])

  const usageAnchor = pagedDetails?.anchor ?? details?.anchor
  const anchoredReference = mode === 'reference' && Boolean(usageAnchor)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!open || !anchoredReference || !usageAnchor || !dialog) return
    const zoom = Number.parseFloat(getComputedStyle(dialog).zoom) || 1
    const preferAbove =
      window.innerHeight - usageAnchor.bottom < Math.min(520, dialog.offsetHeight + 16)
    const placed = getContextMenuStylePosition(
      usageAnchor.left,
      preferAbove ? usageAnchor.top : usageAnchor.bottom + 6,
      { width: dialog.offsetWidth, height: dialog.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      preferAbove,
      zoom,
      { arrowGap: preferAbove ? 6 : 0 }
    )
    setPickerPosition({ x: placed.x, y: placed.y })
  }, [anchoredReference, filteredCandidates.length, loadingUsages, open, usageAnchor])

  useEffect(() => {
    if (!open || !anchoredReference) return
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && dialogRef.current?.contains(event.target)) {
        return
      }
      closePicker()
    }
    const dismissOnBlur = () => closePicker()
    const dismissOnResize = () => closePicker()
    window.addEventListener('pointerdown', dismissOutside)
    window.addEventListener('blur', dismissOnBlur)
    window.addEventListener('resize', dismissOnResize)
    return () => {
      window.removeEventListener('pointerdown', dismissOutside)
      window.removeEventListener('blur', dismissOnBlur)
      window.removeEventListener('resize', dismissOnResize)
    }
  }, [anchoredReference, closePicker, open])

  if (!open) return null

  const selectUsageFilter = async (filter: SemanticUsageFilter) => {
    setUsageFilter(filter)
    setActiveIndex(0)
    if (!usageLoader) return
    if (filter === 'all') {
      usageRequestRef.current += 1
      setPagedCandidates(candidates)
      setPagedDetails(details)
      setLoadingUsages(false)
      return
    }
    const request = ++usageRequestRef.current
    setLoadingUsages(true)
    try {
      const page = await usageLoader(filter, 0, 200)
      if (request !== usageRequestRef.current) return
      setPagedCandidates(page.candidates)
      setPagedDetails(page.details)
    } finally {
      if (request === usageRequestRef.current) setLoadingUsages(false)
    }
  }

  const loadMoreUsages = async () => {
    if (!usageLoader || loadingUsages) return
    const request = ++usageRequestRef.current
    setLoadingUsages(true)
    try {
      const page = await usageLoader(usageFilter, pagedCandidates.length, 200)
      if (request !== usageRequestRef.current) return
      const seen = new Set(
        pagedCandidates.map(
          candidate =>
            `${candidate.path}:${candidate.line}:${candidate.column}:${
              candidate.usageKind ?? candidate.kind
            }`
        )
      )
      setPagedCandidates([
        ...pagedCandidates,
        ...page.candidates.filter(candidate => {
          const key = `${candidate.path}:${candidate.line}:${candidate.column}:${
            candidate.usageKind ?? candidate.kind
          }`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }),
      ])
      setPagedDetails(page.details)
    } finally {
      if (request === usageRequestRef.current) setLoadingUsages(false)
    }
  }

  const choose = (candidate: DefinitionCandidate) => {
    closePicker()
    void jumpToDefinitionCandidate(candidate)
  }
  const activeDetails = mode === 'reference' && usageLoader ? pagedDetails : details
  const totalCount = activeDetails?.totalCount ?? candidates.length
  const displayCount = activeDetails?.complete === false ? `${totalCount}+` : String(totalCount)
  const selectedKindLabel = kindLabel(activeDetails?.kind ?? 'symbol')
  const filters: Array<{
    value: SemanticUsageFilter
    label: string
    icon: ReactNode
  }> = [
    { value: 'all', label: t('全部'), icon: <List size={14} /> },
    { value: 'read', label: t('读取'), icon: <BookOpen size={14} /> },
    { value: 'write', label: t('写入'), icon: <Pencil size={14} /> },
    { value: 'call', label: t('调用'), icon: <GitFork size={14} /> },
    { value: 'import', label: t('导入'), icon: <Package size={14} /> },
    { value: 'approximate', label: t('近似'), icon: <CircleHelp size={14} /> },
  ]

  const dialog = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal={anchoredReference ? undefined : true}
      aria-labelledby="definition-picker-title"
      style={anchoredReference ? { left: pickerPosition.x, top: pickerPosition.y } : undefined}
      className={`ui-font-scaled modal-content-enter flex flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50 ${
        anchoredReference
          ? 'fixed z-[125] max-h-[min(720px,82vh)] w-[min(980px,calc(100vw-16px))]'
          : `relative w-full ${
              mode === 'reference' ? 'max-h-[min(720px,82vh)] max-w-[980px]' : 'max-w-[680px]'
            }`
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <FileCode2 size={16} className="flex-shrink-0 text-accent" aria-hidden />
        <h2 id="definition-picker-title" className="min-w-0 flex-1 truncate text-[14px] text-fg">
          {mode === 'reference' ? (
            <>
              <span className="text-fg-muted">{t(selectedKindLabel)}</span>{' '}
              <span className="font-semibold">{symbol}</span>
              {activeDetails?.origin && (
                <span className="ml-1.5 font-normal text-fg-dim">({activeDetails.origin})</span>
              )}
            </>
          ) : (
            t('选择「{symbol}」的定义', { symbol })
          )}
        </h2>
        {mode === 'reference' && (
          <span className="text-[13px] text-fg-muted">
            {t('{count} 个用法', { count: displayCount })}
          </span>
        )}
        {mode !== 'reference' && (
          <span className="text-ui-sm text-fg-dim">{candidates.length}</span>
        )}
        <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
          Esc
        </kbd>
      </div>

      {mode === 'reference' && (
        <div className="flex items-center gap-1.5 border-b border-border bg-bg px-2.5 py-2">
          {filters.map(filter => {
            const active = usageFilter === filter.value
            return (
              <Tooltip key={filter.value} label={filter.label} side="bottom">
                <button
                  type="button"
                  aria-label={filter.label}
                  aria-pressed={active}
                  className={`flex h-7 items-center gap-1 rounded px-2 text-[11px] transition-colors ${
                    active
                      ? 'bg-bg-active text-fg'
                      : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  }`}
                  onClick={() => void selectUsageFilter(filter.value)}
                >
                  {filter.icon}
                  <span>{filter.label}</span>
                </button>
              </Tooltip>
            )
          })}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <span className="flex items-center gap-1 text-[11px] text-fg-muted">
            <Files size={13} aria-hidden />
            {t('项目文件')}
          </span>
          <span className="ml-auto text-[11px] text-fg-dim">
            {t('显示 {shown} / {total}', {
              shown: filteredCandidates.length,
              total: displayCount,
            })}
          </span>
        </div>
      )}

      <div
        ref={listRef}
        role="listbox"
        aria-label={mode === 'reference' ? t('用法位置') : t('定义候选')}
        className={`overflow-auto py-1 ${
          mode === 'reference' ? 'min-h-[260px] flex-1' : 'max-h-[min(420px,60vh)]'
        }`}
      >
        {filteredCandidates.length === 0 && (
          <div className="flex min-h-[180px] items-center justify-center text-[13px] text-fg-dim">
            {loadingUsages ? t('正在加载用法…') : t('当前筛选没有匹配的用法')}
          </div>
        )}
        {filteredCandidates.map((candidate, index) => {
          const active = index === activeIndex
          const path = splitRelativePath(candidate.relative)
          return (
            <Fragment
              key={`${candidate.path}:${candidate.line}:${candidate.column}:${candidate.usageKind ?? candidate.kind}`}
            >
              {mode === 'reference' &&
                usageFilter === 'all' &&
                candidate.approximate &&
                !filteredCandidates[index - 1]?.approximate && (
                  <div
                    role="separator"
                    className="border-y border-border bg-bg px-3 py-1 text-[10px] text-warn"
                  >
                    {t('近似匹配（可能同名）')}
                  </div>
                )}
              <button
                type="button"
                role="option"
                aria-selected={active}
                data-def-index={index}
                className={`w-full px-3 py-2 text-left transition-colors ${
                  active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(candidate)}
              >
                {mode === 'reference' ? (
                  <span className="grid min-w-[760px] grid-cols-[minmax(170px,230px)_58px_minmax(320px,1fr)_74px] items-center gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <FileCode2 size={15} className="flex-shrink-0 text-warn" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[12px] font-semibold text-fg">
                          {path.file}
                        </span>
                        {path.directory && (
                          <span className="block truncate font-mono text-[10px] text-fg-dim">
                            {path.directory}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="font-mono text-[12px] text-fg-dim">{candidate.line}</span>
                    <span className="min-w-0 truncate font-mono text-[12px]">
                      {highlightedCode(candidate.text, symbol)}
                    </span>
                    <span
                      className={`justify-self-end text-[11px] ${
                        candidate.approximate ? 'text-warn' : 'text-fg-dim'
                      }`}
                    >
                      {t(usageKindLabel(candidate.usageKind))}
                    </span>
                  </span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    <span className="flex w-full items-center gap-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {candidate.callerName
                          ? `${candidate.callerName} · ${candidate.relative}`
                          : candidate.relative}
                      </span>
                      <span className="flex-shrink-0 text-fg-dim">
                        {t(kindLabel(candidate.kind))}
                      </span>
                      <span className="flex-shrink-0 font-mono text-fg-dim">
                        :{candidate.line}:{candidate.column}
                      </span>
                    </span>
                    {candidate.text && (
                      <span className="w-full truncate font-mono text-[11px] text-fg-dim">
                        {candidate.text}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </Fragment>
          )
        })}
        {mode === 'reference' && usageLoader && pagedCandidates.length < totalCount && (
          <div className="flex justify-center border-t border-border px-3 py-2">
            <button
              type="button"
              disabled={loadingUsages}
              className="rounded px-3 py-1.5 text-[11px] text-accent hover:bg-bg-hover disabled:cursor-wait disabled:opacity-60"
              onClick={() => void loadMoreUsages()}
            >
              {loadingUsages ? t('正在加载用法…') : t('加载更多用法')}
            </button>
          </div>
        )}
      </div>
    </div>
  )

  return anchoredReference ? (
    createPortal(dialog, document.body)
  ) : (
    <ModalOverlay onDismiss={closePicker} zIndex="z-[125]">
      {dialog}
    </ModalOverlay>
  )
}
