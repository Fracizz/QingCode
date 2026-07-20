import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { getContextMenuStylePosition } from './contextMenuPosition'
import Tooltip from './Tooltip'

export type SettingSelectOption = {
  value: string
  label: string
  disabled?: boolean
}

type Props = {
  value: string
  options: SettingSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Extra classes on the trigger (e.g. `setting-control-wide`). */
  className?: string
  'aria-label'?: string
}

/**
 * Themed settings dropdown — avoids WebView2 native select popups that
 * ignore app chrome (wrong width, light system list, square corners).
 */
export default function SettingSelect({
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: Props) {
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ left: 0, top: 0, width: 0 })
  const [activeIndex, setActiveIndex] = useState(0)

  const selected = options.find(option => option.value === value) ?? options[0]

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const rect = trigger.getBoundingClientRect()
    const zoom = Number.parseFloat(getComputedStyle(menu).zoom) || 1
    // Match trigger width; clamp vertically like context menus.
    const width = rect.width
    menu.style.width = `${width / zoom}px`
    const placed = getContextMenuStylePosition(
      rect.left,
      rect.bottom + 2,
      { width: menu.offsetWidth || width, height: menu.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      false,
      zoom,
    )
    menu.style.maxHeight = `${placed.maxHeight}px`
    setMenuStyle({
      left: placed.x,
      top: placed.y,
      width: width / zoom,
      maxHeight: placed.maxHeight,
    })
    const selectedIdx = options.findIndex(option => option.value === value)
    const firstEnabled = options.findIndex(option => !option.disabled)
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : Math.max(0, firstEnabled))
    menu.focus()
  }, [open, options, value])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onReposition = () => setOpen(false)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open])

  const moveActive = (delta: number) => {
    const enabledIndexes = options
      .map((option, index) => (option.disabled ? -1 : index))
      .filter(index => index >= 0)
    if (enabledIndexes.length === 0) return
    const currentPos = enabledIndexes.indexOf(activeIndex)
    const start = currentPos >= 0 ? currentPos : 0
    const nextPos = (start + delta + enabledIndexes.length) % enabledIndexes.length
    setActiveIndex(enabledIndexes[nextPos]!)
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
    }
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = options[activeIndex]
      if (option && !option.disabled) {
        onChange(option.value)
        setOpen(false)
        triggerRef.current?.focus()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={`setting-control setting-select setting-select-trigger ${className}`.trim()}
        onClick={() => {
          if (!disabled) setOpen(prev => !prev)
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <Tooltip
          label={selected?.label ?? ''}
          side="bottom"
          onlyWhenOverflow
          wrapperClassName="setting-select-trigger-label min-w-0"
        >
          <span className="block min-w-0 truncate">{selected?.label ?? ''}</span>
        </Tooltip>
        <ChevronDown size={12} className="setting-select-trigger-chevron" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={`${listId}-opt-${activeIndex}`}
            className="menu-enter ui-font-scaled fixed z-[80] overflow-y-auto rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45 outline-none"
            style={menuStyle}
            onKeyDown={onMenuKeyDown}
            onPointerDown={event => event.stopPropagation()}
            onContextMenu={event => event.preventDefault()}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value
              const isActive = index === activeIndex
              return (
                <button
                  key={`${option.value}:${index}`}
                  id={`${listId}-opt-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] outline-none transition-colors
                    ${
                      isActive
                        ? 'bg-bg-active text-fg'
                        : 'text-fg hover:bg-bg-active focus:bg-bg-active'
                    }
                    disabled:cursor-not-allowed disabled:opacity-40`}
                  onMouseEnter={() => {
                    if (!option.disabled) setActiveIndex(index)
                  }}
                  onClick={() => {
                    if (option.disabled) return
                    onChange(option.value)
                    setOpen(false)
                    triggerRef.current?.focus()
                  }}
                >
                  <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
                    {isSelected ? <Check size={14} className="text-fg" /> : null}
                  </span>
                  <Tooltip
                    label={option.label}
                    side="right"
                    onlyWhenOverflow
                    wrapperClassName="min-w-0 flex-1"
                  >
                    <span className="block min-w-0 truncate">{option.label}</span>
                  </Tooltip>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
