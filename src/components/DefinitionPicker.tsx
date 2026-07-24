import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CornerDownRight } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { navigateToDefinition } from '../lib/gotoDefinition/navigate'
import { useProjectStore } from '../store/projectStore'
import { formatFileToastDetail } from '../utils/fileReferences'
import type { DefinitionTarget } from '../lib/gotoDefinition/types'

export default function DefinitionPicker() {
  const { t } = useI18n()
  const open = useDefinitionPickerStore(s => s.open)
  const targets = useDefinitionPickerStore(s => s.targets)
  const closePicker = useDefinitionPickerStore(s => s.closePicker)
  const projects = useProjectStore(s => s.projects)
  const listRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => setActiveIndex(0))
  }, [open, targets])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closePicker()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closePicker])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open) return null

  const jumpTo = (target: DefinitionTarget) => {
    closePicker()
    void navigateToDefinition(target)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(i => (targets.length === 0 ? 0 : (i + 1) % targets.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(i => (targets.length === 0 ? 0 : (i - 1 + targets.length) % targets.length))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = targets[activeIndex]
      if (selected) jumpTo(selected)
    }
  }

  return (
    <ModalOverlay onDismiss={closePicker} zIndex="z-[120]">
      <div
        className="ui-font-scaled modal-content-enter relative flex max-h-[min(420px,70vh)] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        role="dialog"
        aria-modal="true"
        aria-label={t('选择定义')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        ref={el => el?.focus()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-ui-sm text-fg-dim">
          <CornerDownRight size={14} />
          <span>{t('选择定义')}</span>
          <span className="ml-auto font-mono text-[11px]">{targets.length}</span>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {targets.map((target, index) => {
            const detail = formatFileToastDetail(projects, target.path)
            const active = index === activeIndex
            return (
              <button
                key={`${target.path}:${target.line}:${target.from ?? index}`}
                type="button"
                data-index={index}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm ${
                  active ? 'bg-accent/15 text-fg' : 'text-fg hover:bg-hover'
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => jumpTo(target)}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{detail}</span>
                {target.label ? (
                  <span className="flex-shrink-0 text-[11px] text-fg-dim">{t(labelKey(target.label))}</span>
                ) : null}
                <span className="w-10 flex-shrink-0 text-right font-mono text-fg-dim">
                  :{target.line}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </ModalOverlay>
  )
}

function labelKey(label: string): string {
  switch (label) {
    case 'function':
      return '函数'
    case 'class':
      return '类'
    case 'method':
      return '方法'
    case 'variable':
      return '变量'
    case 'module':
      return '模块'
    case 'package':
      return '包'
    case 'mod':
      return '模块'
    case 'type':
      return '类型'
    case 'heading':
      return '标题'
    case 'selector':
      return '选择器'
    default:
      return label
  }
}
