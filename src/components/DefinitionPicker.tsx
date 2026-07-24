import { useEffect, useRef, useState } from 'react'
import { FileCode2 } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import {
  jumpToDefinitionCandidate,
  type DefinitionCandidate,
} from '../lib/definitionNavigation'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useI18n } from '../lib/i18n'

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
    default:
      return kind
  }
}

export default function DefinitionPicker() {
  const { t } = useI18n()
  const open = useDefinitionPickerStore(state => state.open)
  const mode = useDefinitionPickerStore(state => state.mode)
  const symbol = useDefinitionPickerStore(state => state.symbol)
  const candidates = useDefinitionPickerStore(state => state.candidates)
  const closePicker = useDefinitionPickerStore(state => state.closePicker)
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) queueMicrotask(() => setActiveIndex(0))
  }, [open, candidates])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePicker()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(index => (index + 1) % candidates.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(index => (index - 1 + candidates.length) % candidates.length)
      } else if (event.key === 'Enter') {
        const candidate = candidates[activeIndex]
        if (!candidate) return
        event.preventDefault()
        closePicker()
        void jumpToDefinitionCandidate(candidate)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activeIndex, candidates, closePicker, open])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-def-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const choose = (candidate: DefinitionCandidate) => {
    closePicker()
    void jumpToDefinitionCandidate(candidate)
  }

  return (
    <ModalOverlay onDismiss={closePicker} zIndex="z-[125]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="definition-picker-title"
        className="ui-font-scaled modal-content-enter relative flex w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <FileCode2 size={16} className="flex-shrink-0 text-accent" aria-hidden />
          <h2 id="definition-picker-title" className="min-w-0 flex-1 truncate text-[13px] text-fg">
            {mode === 'reference'
              ? t('「{symbol}」的调用', { symbol })
              : t('选择「{symbol}」的定义', { symbol })}
          </h2>
          <span className="text-ui-sm text-fg-dim">{candidates.length}</span>
          <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={mode === 'reference' ? t('调用位置') : t('定义候选')}
          className="max-h-[min(420px,60vh)] overflow-y-auto py-1"
        >
          {candidates.map((candidate, index) => {
            const active = index === activeIndex
            return (
              <button
                key={`${candidate.path}:${candidate.line}:${candidate.column}`}
                type="button"
                role="option"
                aria-selected={active}
                data-def-index={index}
                className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                  active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(candidate)}
              >
                <span className="flex w-full items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {candidate.callerName
                      ? `${candidate.callerName} · ${candidate.relative}`
                      : candidate.relative}
                  </span>
                  <span className="flex-shrink-0 text-fg-dim">{t(kindLabel(candidate.kind))}</span>
                  <span className="flex-shrink-0 font-mono text-fg-dim">
                    :{candidate.line}:{candidate.column}
                  </span>
                </span>
                {candidate.text && (
                  <span className="w-full truncate font-mono text-[11px] text-fg-dim">
                    {candidate.text}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </ModalOverlay>
  )
}
