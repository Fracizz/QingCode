import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Boxes } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import { jumpToDefinitionCandidate } from '../lib/definitionNavigation'
import {
  searchWorkspaceSymbols,
  type WorkspaceSymbolCandidate,
} from '../lib/symbolNavigation'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { useWorkspaceSymbolPickerStore } from '../store/workspaceSymbolPickerStore'

export default function WorkspaceSymbolPicker() {
  const { t } = useI18n()
  const open = useWorkspaceSymbolPickerStore(state => state.open)
  const closePicker = useWorkspaceSymbolPickerStore(state => state.closePicker)
  const project = useProjectStore(state => state.currentProject)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSymbolCandidate[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setQuery('')
      setResults([])
      setActiveIndex(0)
    })
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    if (!open || !project) return
    const request = ++requestRef.current
    setLoading(true)
    const id = window.setTimeout(() => {
      void searchWorkspaceSymbols(project.path, query)
        .then(items => {
          if (request !== requestRef.current) return
          setResults(items)
          setActiveIndex(0)
        })
        .catch(() => {
          if (request !== requestRef.current) return
          setResults([])
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false)
        })
    }, 120)
    return () => window.clearTimeout(id)
  }, [open, project, query])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-workspace-symbol-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePicker()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closePicker, open])

  if (!open) return null

  const jumpTo = (candidate: WorkspaceSymbolCandidate) => {
    closePicker()
    void jumpToDefinitionCandidate({ ...candidate, score: 0 })
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(index => (results.length === 0 ? 0 : (index + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const selected = results[activeIndex]
      if (selected) jumpTo(selected)
    }
  }

  const emptyMessage = !project
    ? t('请先打开项目')
    : loading
      ? t('正在搜索工作区符号…')
      : t('没有匹配的工作区符号')

  return (
    <ModalOverlay onDismiss={closePicker} zIndex="z-[124]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-symbol-picker-title"
        className="ui-font-scaled modal-content-enter relative flex w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <h2 id="workspace-symbol-picker-title" className="sr-only">
          {t('转到工作区中的符号')}
        </h2>
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <Boxes size={16} className="flex-shrink-0 text-fg-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('输入工作区符号名称…')}
            className="modal-search-input"
          />
          <span className="text-ui-sm text-fg-dim">{results.length}</span>
          <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('工作区符号')}
          className="max-h-[min(420px,60vh)] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-fg-dim">{emptyMessage}</p>
          ) : (
            results.map((candidate, index) => {
              const active = index === activeIndex
              return (
                <button
                  key={`${candidate.path}:${candidate.line}:${candidate.column}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-workspace-symbol-index={index}
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                    active
                      ? 'bg-accent/20 text-fg'
                      : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => jumpTo(candidate)}
                >
                  <span className="flex w-full items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-mono">{candidate.name}</span>
                    <span className="flex-shrink-0 text-fg-dim">{candidate.kind}</span>
                    <span className="max-w-[45%] flex-shrink truncate font-mono text-fg-dim">
                      {candidate.relative}:{candidate.line}
                    </span>
                  </span>
                  {candidate.text && (
                    <span className="w-full truncate font-mono text-[11px] text-fg-dim">
                      {candidate.text}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
