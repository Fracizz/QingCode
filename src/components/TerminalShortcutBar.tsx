import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Delete,
  Ellipsis,
} from 'lucide-react'
import { useI18n } from '../lib/i18n'
import {
  builtinKeyInfo,
  customKeyDetail,
  customKeyLabel,
  findCustomKey,
  fitShortcutKeyCount,
  isBuiltinShortcutKey,
  visibleShortcutKeys,
  type TerminalCustomKey,
  type TerminalShortcutBuiltinKey,
} from '../lib/terminal/terminalShortcutBar'
import { useTerminalShortcutBarStore } from '../store/terminalShortcutBarStore'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'

/** 按钮间距（px），与 gap-1 一致。 */
const GAP = 4
/** 按住连发：首次延迟与间隔（与常见键盘重复速率接近）。 */
const REPEAT_DELAY = 400
const REPEAT_INTERVAL = 60

const ICONS: Partial<Record<TerminalShortcutBuiltinKey, ReactNode>> = {
  up: <ArrowUp size={12} />,
  down: <ArrowDown size={12} />,
  left: <ArrowLeft size={12} />,
  right: <ArrowRight size={12} />,
  backspace: <Delete size={12} />,
}

export interface TerminalShortcutBarProps {
  /** 终端不可写（未启动 / 已退出 / 被独占只读）时按钮全部灰显。 */
  disabled: boolean
  onBuiltinKey: (key: TerminalShortcutBuiltinKey) => void
  onCustomKey: (def: TerminalCustomKey) => void
}

/**
 * 终端格子底部的快捷键栏：点击即发送到本格终端，不抢走 xterm 焦点。
 * 放不下的键与在设置中隐藏的键收进「⋯」菜单；最右侧按钮收起整栏（全局共用折叠状态）。
 */
export default function TerminalShortcutBar({ disabled, onBuiltinKey, onCustomKey }: TerminalShortcutBarProps) {
  const { t } = useI18n()
  const order = useTerminalShortcutBarStore(s => s.order)
  const hidden = useTerminalShortcutBarStore(s => s.hidden)
  const custom = useTerminalShortcutBarStore(s => s.custom)
  const setCollapsed = useTerminalShortcutBarStore(s => s.setCollapsed)
  const layout = { order, hidden, custom }
  const { bar, overflow } = visibleShortcutKeys(layout)
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [fit, setFit] = useState(bar.length)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const repeatRef = useRef<{ timer: number; interval: number } | null>(null)
  const barKey = bar.join('\n') + '\n' + custom.map(def => customKeyLabel(def)).join('\n')

  // 按实际宽度决定栏内放几个键：隐藏的测量行里渲染全部按钮取宽度，容器变宽变窄时重算。
  useLayoutEffect(() => {
    const row = rowRef.current
    const measure = measureRef.current
    if (!row || !measure) return
    const recompute = () => {
      const widths = [...measure.children].map(child => (child as HTMLElement).offsetWidth)
      const controls = row.querySelector<HTMLElement>('[data-shortcut-controls]')
      const available = row.clientWidth - (controls?.offsetWidth ?? 0) - GAP - 8
      setFit(fitShortcutKeyCount(widths, Math.max(0, available), GAP))
    }
    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(row)
    return () => observer.disconnect()
  }, [barKey])

  const stopRepeat = () => {
    const repeat = repeatRef.current
    if (!repeat) return
    window.clearTimeout(repeat.timer)
    window.clearInterval(repeat.interval)
    repeatRef.current = null
  }
  useEffect(() => stopRepeat, [])
  useEffect(() => {
    if (disabled) stopRepeat()
  }, [disabled])

  const press = (key: string) => {
    if (disabled) return
    if (isBuiltinShortcutKey(key)) {
      onBuiltinKey(key)
      return
    }
    const def = findCustomKey(layout, key)
    if (def) onCustomKey(def)
  }

  const keyName = (key: string) => {
    const def = findCustomKey(layout, key)
    if (def) return def.name ? `${def.name} · ${customKeyDetail(def)}` : customKeyDetail(def)
    const info = builtinKeyInfo(key)
    return info ? t(info.name) : key
  }

  const keyContent = (key: string): ReactNode => {
    const def = findCustomKey(layout, key)
    if (def) return customKeyLabel(def)
    if (isBuiltinShortcutKey(key) && ICONS[key]) return ICONS[key]
    const info = builtinKeyInfo(key)
    return info ? t(info.label) : key
  }

  const tip = (key: string) => {
    const def = findCustomKey(layout, key)
    const name = keyName(key)
    return def?.shortcut ? `${name}（${def.shortcut}）` : name
  }

  const keyButton = (key: string, measuring = false) => {
    const info = isBuiltinShortcutKey(key) ? builtinKeyInfo(key) : undefined
    const repeat = info?.repeat === true
    const className = `terminal-shortcut-key${findCustomKey(layout, key) ? ' terminal-shortcut-custom' : ''}`
    if (measuring) {
      return (
        <span key={key} className={className} aria-hidden>
          {keyContent(key)}
        </span>
      )
    }
    return (
      <Tooltip key={key} label={tip(key)} side="top">
        <button
          type="button"
          className={className}
          disabled={disabled}
          aria-label={keyName(key)}
          data-shortcut-key={key}
          onPointerDown={event => {
            // 不抢走 xterm 焦点：点完可以接着打字。
            event.preventDefault()
            if (!repeat || event.button !== 0 || disabled) return
            stopRepeat()
            press(key)
            const timer = window.setTimeout(() => {
              const interval = window.setInterval(() => press(key), REPEAT_INTERVAL)
              if (repeatRef.current) repeatRef.current.interval = interval
            }, REPEAT_DELAY)
            repeatRef.current = { timer, interval: 0 }
          }}
          onPointerUp={stopRepeat}
          onPointerLeave={stopRepeat}
          onPointerCancel={stopRepeat}
          onClick={event => {
            // 连发键在 pointerdown 已发送；键盘激活（detail 为 0）两类都在这里发送。
            if (repeat && event.detail !== 0) return
            press(key)
          }}
        >
          {keyContent(key)}
        </button>
      </Tooltip>
    )
  }

  const shown = bar.slice(0, fit)
  const spilled = bar.slice(fit)

  const menuItems = (): ContextMenuItem[] => {
    const item = (key: string, separatorBefore = false): ContextMenuItem => ({
      label: keyName(key),
      disabled,
      separatorBefore,
      shortcut: findCustomKey(layout, key)?.shortcut || undefined,
      action: () => press(key),
    })
    const items: ContextMenuItem[] = [
      ...spilled.map(key => item(key)),
      ...overflow.map((key, index) => item(key, index === 0 && spilled.length > 0)),
    ]
    items.push(
      {
        label: t('配置快捷键栏…'),
        separatorBefore: items.length > 0,
        action: () => useTerminalShortcutBarStore.getState().openManager(),
      },
      { label: t('收起快捷键栏'), action: () => setCollapsed(true) },
    )
    return items
  }

  return (
    <div
      ref={rowRef}
      role="toolbar"
      aria-label={t('终端快捷键栏')}
      className="terminal-shortcut-bar"
      data-disabled={disabled || undefined}
      onContextMenu={event => {
        // 栏内右键打开「⋯」菜单，而不是终端右键菜单。
        event.preventDefault()
        event.stopPropagation()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <div ref={measureRef} className="terminal-shortcut-measure" aria-hidden>
        {bar.map(key => keyButton(key, true))}
      </div>
      <div className="terminal-shortcut-keys">{shown.map(key => keyButton(key))}</div>
      <div data-shortcut-controls className="terminal-shortcut-controls">
        <Tooltip label={t('更多快捷键')} side="top">
          <button
            ref={moreRef}
            type="button"
            className="terminal-shortcut-icon"
            aria-label={t('更多快捷键')}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onPointerDown={event => event.preventDefault()}
            onClick={() => {
              const rect = moreRef.current?.getBoundingClientRect()
              if (rect) setMenu({ x: rect.left, y: rect.top - 4 })
            }}
          >
            <Ellipsis size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('收起快捷键栏')} side="top">
          <button
            type="button"
            className="terminal-shortcut-icon"
            aria-label={t('收起快捷键栏')}
            aria-expanded
            onPointerDown={event => event.preventDefault()}
            onClick={() => setCollapsed(true)}
          >
            <ChevronDown size={14} />
          </button>
        </Tooltip>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} preferAbove items={menuItems()} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/** 折叠后留在终端右下角的展开按钮：浮在终端上，不占高度，避免改变终端行数。 */
export function TerminalShortcutBarExpand() {
  const { t } = useI18n()
  const setCollapsed = useTerminalShortcutBarStore(s => s.setCollapsed)
  return (
    <div className="terminal-shortcut-expand">
      <Tooltip label={t('展开快捷键栏')} side="left">
        <button
          type="button"
          aria-label={t('展开快捷键栏')}
          aria-expanded={false}
          onPointerDown={event => event.preventDefault()}
          onMouseDown={event => event.stopPropagation()}
          onClick={() => setCollapsed(false)}
        >
          <ChevronUp size={12} />
        </button>
      </Tooltip>
    </div>
  )
}
