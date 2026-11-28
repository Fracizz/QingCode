import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Send } from 'lucide-react'
import { t } from '@qn/codex-client'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '../../components/primitives'
import { cn } from '../../lib/cn'
import type { ComposerShortcut } from './shortcuts'

export type ShortcutAction = 'fill' | 'send' | 'queue'
const chipClass = 'inline-flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-full border border-qn-border-strong bg-qn-panel px-2.5 text-ui-sm font-medium'
const buttonClass = 'min-w-0 text-qn-text outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-outline-hover disabled:opacity-50'

function actionLabel(action: ShortcutAction) {
  return action === 'fill' ? t('填入文字') : action === 'send' ? t('发送') : t('排队')
}

export function ComposerShortcutBar({ shortcuts, disabled, pendingId, actionFor, onActivate }: {
  shortcuts: readonly ComposerShortcut[]
  disabled: boolean
  pendingId: string | null
  actionFor: (shortcut: ComposerShortcut) => ShortcutAction
  onActivate: (shortcut: ComposerShortcut) => boolean
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(shortcuts.length)
  const selectedFromMenu = useRef(false)

  useLayoutEffect(() => {
    const row = rowRef.current
    const probe = probeRef.current
    if (!row || !probe) return

    const measure = () => {
      const width = row.getBoundingClientRect().width
      const gap = Number.parseFloat(getComputedStyle(probe).columnGap) || 0
      const widths = Array.from(probe.children, (node) => node.getBoundingClientRect().width)
      const moreWidth = widths.pop() ?? 0
      const total = widths.reduce((sum, item) => sum + item, 0) + gap * Math.max(0, widths.length - 1)
      if (total <= width) {
        setVisibleCount(widths.length)
        return
      }
      // 从左到右保留标签，并预留「更多」按钮的位置。
      let remaining = width - moreWidth
      let count = 0
      for (const item of widths) {
        if (item + gap > remaining) break
        remaining -= item + gap
        count++
      }
      setVisibleCount(count)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [shortcuts])

  const overflow = shortcuts.slice(visibleCount)
  const more = <>{t('更多')}<ChevronDown size={13} className="shrink-0" aria-hidden /></>

  return (
    <div className="relative mb-1.5 min-w-0">
      <div ref={rowRef} role="group" aria-label={t('输入框快捷标签')} className="flex min-w-0 items-center gap-1.5">
        {shortcuts.slice(0, visibleCount).map((shortcut) => {
          const label = `${shortcut.name} · ${actionLabel(actionFor(shortcut))}`
          return (
            <Tip key={shortcut.id} label={label}>
              <button
                type="button"
                className={cn(chipClass, buttonClass)}
                aria-label={label}
                disabled={disabled || pendingId === shortcut.id}
                onKeyDown={(event) => {
                  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
                }}
                onClick={(event) => {
                  if (event.detail <= 1) onActivate(shortcut)
                }}
              >
                {shortcut.send && <Send size={13} className="shrink-0 text-qn-muted" aria-hidden />}
                <span className="truncate">{shortcut.name}</span>
              </button>
            </Tip>
          )
        })}
        {overflow.length > 0 && (
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={cn(chipClass, buttonClass, 'max-w-full')} disabled={disabled}>{more}</button>
            </MenuTrigger>
            <MenuContent
              side="top"
              className="qn-scroll max-h-(--radix-dropdown-menu-content-available-height) max-w-80 overflow-y-auto"
              onCloseAutoFocus={(event) => {
                if (selectedFromMenu.current) event.preventDefault()
                selectedFromMenu.current = false
              }}
            >
              {overflow.map((shortcut) => (
                <MenuItem
                  key={shortcut.id}
                  disabled={disabled || pendingId === shortcut.id}
                  icon={shortcut.send ? <Send size={13} aria-hidden /> : undefined}
                  hint={actionLabel(actionFor(shortcut))}
                  title={shortcut.name}
                  onSelect={() => { selectedFromMenu.current = onActivate(shortcut) }}
                >{shortcut.name}</MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
      </div>
      <div aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={probeRef} className="flex w-max gap-1.5">
          {shortcuts.map((shortcut) => (
            <span key={shortcut.id} className={chipClass}>
              {shortcut.send && <Send size={13} className="shrink-0" />}
              <span className="truncate">{shortcut.name}</span>
            </span>
          ))}
          <span className={chipClass}>{more}</span>
        </div>
      </div>
    </div>
  )
}
