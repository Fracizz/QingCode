import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Command } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'
import {
  buildCommands,
  filterCommands,
  resolveCommandShortcut,
  type RankedCommand,
} from '../lib/commands'
import { useCommandPaletteStore } from '../store/commandPaletteStore'
import { useShortcutStore } from '../store/shortcutStore'

const MAX_VISIBLE = 12

export default function CommandPalette() {
  const { t } = useI18n()
  const open = useCommandPaletteStore(s => s.open)
  const closePalette = useCommandPaletteStore(s => s.closePalette)
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setTick(n => n + 1)
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [open])

  const results = useMemo(() => {
    void tick
    return filterCommands(buildCommands(), query, t).slice(0, MAX_VISIBLE)
  }, [query, t, tick])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, tick])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePalette()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closePalette])

  if (!open) return null

  const runCommand = async (command: RankedCommand) => {
    closePalette()
    try {
      await command.run()
    } catch (error) {
      console.error('command failed:', command.id, error)
    }
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
      if (selected) void runCommand(selected)
    }
  }

  return (
    <ModalOverlay onDismiss={closePalette} zIndex="z-[120]" align="start" className="pt-[12vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('命令面板')}
        className="relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Command size={16} className="flex-shrink-0 text-fg-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('输入命令名称进行筛选…')}
            aria-controls="command-palette-list"
            aria-activedescendant={
              results[activeIndex] ? `command-palette-item-${results[activeIndex].id}` : undefined
            }
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-dim"
          />
          <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-dim sm:inline">
            Esc
          </kbd>
        </div>
        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label={t('命令')}
          className="max-h-[min(360px,50vh)] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-fg-dim">{t('没有匹配的命令')}</p>
          ) : (
            results.map((command, index) => {
              const shortcut = resolveCommandShortcut(command, shortcuts)
              const active = index === activeIndex
              return (
                <button
                  key={command.id}
                  id={`command-palette-item-${command.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-cmd-index={index}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors ${
                    active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void runCommand(command)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t(command.title, command.titleValues)}
                  </span>
                  {shortcut && (
                    <span className="flex-shrink-0 font-mono text-[11px] text-fg-dim">{shortcut}</span>
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
