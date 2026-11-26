import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlert, Command, History, X } from 'lucide-react'
import { Dialog, VisuallyHidden } from 'radix-ui'
import { cn } from '../../lib/cn'
import {
  executeCommand,
  formatShortcut,
  moveSelection,
  normalizeQuery,
  rankCommands,
  type RankedCommand,
} from './paletteModel'
import { splitHighlight } from './match'
import { commandRegistry, useCommands, type CommandRegistry } from './registry'
import { useCommandPalette } from './paletteStore'
import type { PaletteCommand } from './types'

/** PageUp/PageDown 每次跳的条数，约等于列表可视行数 */
const PAGE_SIZE = 10

export type CommandPaletteProps = {
  /** 命令执行失败时的提示方式；不传则重新打开面板并在面板内显示错误行 */
  onError?: (message: string, command: PaletteCommand) => void
  /** 测试或多实例场景可换注册表，默认用全局单例 */
  registry?: CommandRegistry
}

function Highlighted({ text, positions }: { text: string; positions: readonly number[] }): ReactNode {
  return splitHighlight(text, positions).map((segment, index) =>
    segment.hit ? (
      <span key={index} className="font-semibold text-qn-accent">
        {segment.text}
      </span>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  )
}

function ShortcutKeys({ shortcut }: { shortcut: string }) {
  const label = formatShortcut(shortcut)
  if (!label) return null
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={`快捷键 ${label}`}>
      {label.split(' ').map((chord, ci) => (
        <span key={ci} className="flex items-center gap-0.5">
          {chord.split(/\+(?!$)/).map((key, ki) => (
            <kbd
              key={ki}
              className="rounded border border-qn-border-strong bg-white/5 px-1.5 py-px font-sans text-[11px] leading-4 text-qn-muted"
            >
              {key}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

/**
 * Ctrl+Shift+P 命令面板：居中浮层，输入即模糊过滤已登记命令。
 * 宿主只需在根组件渲染一次，开关由 openCommandPalette / closeCommandPalette 控制。
 */
export function CommandPalette({ onError, registry = commandRegistry }: CommandPaletteProps) {
  const open = useCommandPalette((s) => s.open)
  if (!open) return null
  return <PaletteBody onError={onError} registry={registry} />
}

function PaletteBody({ onError, registry }: Required<Pick<CommandPaletteProps, 'registry'>> & CommandPaletteProps) {
  const initialQuery = useCommandPalette((s) => s.initialQuery)
  const error = useCommandPalette((s) => s.error)
  const recent = useCommandPalette((s) => s.recent)
  const commands = useCommands(registry)
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // when() 在打开时与命令/查询变化时重新求值，面板开着期间状态变化不追踪
  const ranked = useMemo(() => rankCommands(commands, query, recent), [commands, query, recent])

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(0, ranked.length - 1)))
  }, [ranked.length])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const close = (): void => useCommandPalette.getState().closePalette()

  const choose = (item: RankedCommand | undefined): void => {
    if (!item) return
    const state = useCommandPalette.getState()
    state.markUsed(item.command.id)
    // 先关面板再执行：命令常常会打开别的对话框（快速打开、设置），两个模态叠在一起会抢焦点
    state.closePalette()
    void executeCommand(item.command, onError ?? ((message) => useCommandPalette.getState().showError(message)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const keyMap: Record<string, Parameters<typeof moveSelection>[2]> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      PageUp: 'pageUp',
      PageDown: 'pageDown',
    }
    const move = keyMap[event.key]
    if (move) {
      event.preventDefault()
      setSelected((index) => moveSelection(index, ranked.length, move, PAGE_SIZE))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      choose(ranked[selected])
    }
  }

  const activeId = ranked[selected] ? `qn-palette-item-${selected}` : undefined
  const firstRest = ranked.findIndex((item) => !item.recent)

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <Dialog.Portal>
        {/* 用 flex 居中而不是 translate：qn-pop 动画会改写 transform */}
        <Dialog.Overlay className="qn-no-drag fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]">
          <Dialog.Content
            aria-describedby={undefined}
            className="qn-pop flex max-h-[min(520px,70vh)] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-qn-border-strong bg-qn-panel shadow-[0_24px_80px_rgba(0,0,0,0.55)] outline-none"
          >
            <VisuallyHidden.Root>
              <Dialog.Title>命令面板</Dialog.Title>
            </VisuallyHidden.Root>
            <div className="flex shrink-0 items-center gap-2 border-b border-qn-border px-3 py-2.5">
              <Command size={15} className="shrink-0 text-qn-muted" />
              <input
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-[14px] text-qn-text outline-none placeholder:text-qn-dim"
                value={query}
                placeholder="输入命令名称"
                role="combobox"
                aria-expanded
                aria-controls="qn-palette-list"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
            {error && (
              <div className="flex shrink-0 items-start gap-2 border-b border-qn-border bg-qn-danger/10 px-3 py-2 text-[12px] text-qn-danger">
                <CircleAlert size={14} className="mt-px shrink-0" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
                <button
                  type="button"
                  aria-label="关闭错误提示"
                  className="shrink-0 opacity-70 hover:opacity-100"
                  onClick={() => useCommandPalette.getState().clearError()}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            <div
              ref={listRef}
              id="qn-palette-list"
              role="listbox"
              aria-label="命令"
              className="qn-scroll min-h-0 flex-1 overflow-y-auto py-1"
            >
              {ranked.length === 0 && (
                <div className="px-3 py-6 text-center text-[13px] text-qn-muted">没有匹配的命令</div>
              )}
              {ranked.map((item, index) => (
                <div
                  key={item.command.id}
                  id={`qn-palette-item-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === selected}
                  className={cn(
                    'mx-1 flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]',
                    index === selected ? 'bg-qn-accent/20 text-qn-text' : 'text-qn-text/90',
                    // 最近使用与其余命令之间画一道分隔线
                    index === firstRest && firstRest > 0 && 'mt-1 border-t border-qn-border pt-2',
                  )}
                  // 用 mousemove 而非 mouseenter：键盘滚动列表时鼠标静止不应抢走选中项
                  onMouseMove={() => {
                    if (index !== selected) setSelected(index)
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {item.command.category && (
                      <span className="text-qn-muted">
                        <Highlighted text={item.command.category} positions={item.categoryPositions} />
                        {': '}
                      </span>
                    )}
                    <Highlighted text={item.command.title} positions={item.titlePositions} />
                  </span>
                  {item.recent && index === 0 && !normalizeQuery(query) && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-qn-dim">
                      <History size={11} />
                      最近使用
                    </span>
                  )}
                  {item.command.shortcut && <ShortcutKeys shortcut={item.command.shortcut} />}
                </div>
              ))}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-qn-border px-3 py-1.5 text-[11px] text-qn-dim">
              <span>↑↓ 选择 · PageUp/PageDown 翻页 · Enter 执行 · Esc 关闭</span>
              <span>{ranked.length} 条命令</span>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
