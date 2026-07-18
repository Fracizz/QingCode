import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ListTree } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'
import { fuzzyScore } from '../lib/commands'
import {
  editorSymbolKindLabel,
  extractEditorSymbols,
  type EditorSymbol,
} from '../lib/editorSymbols'
import { getEditorView } from '../lib/editorSession'
import { useEditorStore } from '../store/editorStore'
import { useSymbolPickerStore } from '../store/symbolPickerStore'
import { isLoadingTab, isOpenErrorTab } from '../lib/openFileError'

const MAX_VISIBLE = 40

function filterSymbols(symbols: EditorSymbol[], query: string): EditorSymbol[] {
  const ranked = symbols
    .map(symbol => ({
      symbol,
      score: fuzzyScore(query, `${symbol.name} ${symbol.kind}`),
    }))
    .filter(item => item.score > 0)
  ranked.sort((a, b) => b.score - a.score || a.symbol.line - b.symbol.line)
  return ranked.map(item => item.symbol)
}

export default function SymbolPicker() {
  const { t } = useI18n()
  const open = useSymbolPickerStore(s => s.open)
  const closePicker = useSymbolPickerStore(s => s.closePicker)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const tabs = useEditorStore(s => s.tabs)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null

  const symbols = useMemo(() => {
    if (!open || !activeTab || isOpenErrorTab(activeTab) || isLoadingTab(activeTab)) return []
    const view = activeTabId ? getEditorView(activeTabId) : undefined
    if (!view) return []
    return extractEditorSymbols(view.state)
  }, [open, activeTab, activeTabId])

  const results = useMemo(() => filterSymbols(symbols, query).slice(0, MAX_VISIBLE), [symbols, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, symbols])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sym-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePicker()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closePicker])

  if (!open) return null

  const jumpTo = (symbol: EditorSymbol) => {
    if (!activeTab) {
      closePicker()
      return
    }
    closePicker()
    useEditorStore.setState({
      pendingReveal: { path: activeTab.path, line: symbol.line, from: symbol.from },
    })
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(i => (results.length === 0 ? 0 : (i + 1) % results.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(i => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = results[activeIndex]
      if (selected) jumpTo(selected)
    }
  }

  const emptyMessage =
    !activeTab || isOpenErrorTab(activeTab) || isLoadingTab(activeTab)
      ? t('没有可导航的编辑器文档')
      : symbols.length === 0
        ? t('当前文件没有可识别的符号')
        : t('没有匹配的符号')

  return (
    <ModalOverlay onDismiss={closePicker} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('转到编辑器中的符号')}
        className="ui-font-scaled modal-content-enter relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <ListTree size={16} className="flex-shrink-0 text-fg-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('输入符号名称进行筛选…')}
            aria-controls="symbol-picker-list"
            aria-activedescendant={
              results[activeIndex]
                ? `symbol-picker-item-${results[activeIndex].from}`
                : undefined
            }
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-dim"
          />
          <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-dim sm:inline">
            Esc
          </kbd>
        </div>
        <div
          id="symbol-picker-list"
          ref={listRef}
          role="listbox"
          aria-label={t('符号')}
          className="max-h-[min(360px,50vh)] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-fg-dim">{emptyMessage}</p>
          ) : (
            results.map((symbol, index) => {
              const active = index === activeIndex
              return (
                <button
                  key={`${symbol.from}:${symbol.name}`}
                  id={`symbol-picker-item-${symbol.from}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-sym-index={index}
                  className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-[13px] transition-colors ${
                    active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => jumpTo(symbol)}
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono"
                    style={{ paddingLeft: Math.min(symbol.depth, 6) * 12 }}
                  >
                    {symbol.name}
                  </span>
                  <span className="flex-shrink-0 text-[11px] text-fg-dim">
                    {t(editorSymbolKindLabel(symbol.kind))}
                  </span>
                  <span className="w-10 flex-shrink-0 text-right font-mono text-[11px] text-fg-dim">
                    :{symbol.line}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
