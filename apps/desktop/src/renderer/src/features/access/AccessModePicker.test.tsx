// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, type ComponentProps, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DialogFrame } from '../../components/DialogFrame'
import type { MenuContent, MenuItem } from '../../components/primitives'
import { AccessModePicker } from './AccessModePicker'

let closeMenu: ComponentProps<typeof MenuContent>['onCloseAutoFocus']

vi.mock('../../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('radix-ui', () => ({
  Dialog: {
    Title: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
    Description: ({ children }: PropsWithChildren) => <p>{children}</p>,
    Close: ({ children }: PropsWithChildren) => children,
  },
}))
vi.mock('../../components/primitives', () => ({
  Menu: ({ children }: PropsWithChildren) => children,
  MenuTrigger: ({ children }: PropsWithChildren) => children,
  MenuContent: ({ children, onCloseAutoFocus }: ComponentProps<typeof MenuContent>) => {
    closeMenu = onCloseAutoFocus
    return children
  },
  MenuItem: ({ children, onSelect }: ComponentProps<typeof MenuItem>) => (
    <button onClick={() => onSelect?.(new Event('select'))}>{children}</button>
  ),
  Tip: ({ children }: PropsWithChildren) => children,
}))
vi.mock('../../components/DialogFrame', () => ({
  DialogFrame: ({ children, onOpenAutoFocus, onCloseAutoFocus }: ComponentProps<typeof DialogFrame>) => {
    const dialog = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      const element = dialog.current
      if (!element) return
      const event = new Event('openAutoFocus', { cancelable: true })
      element.addEventListener(event.type, (event) => onOpenAutoFocus?.(event), { once: true })
      if (element.dispatchEvent(event)) element.querySelector('button')?.focus()
      return () => {
        onCloseAutoFocus?.(new Event('closeAutoFocus', { cancelable: true }))
      }
    }, [onCloseAutoFocus, onOpenAutoFocus])
    return <div ref={dialog} role="dialog" tabIndex={-1}>{children}</div>
  },
}))

it('授权确认打开时聚焦弹窗，关闭后焦点回到访问模式按钮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onChange = vi.fn()
  const button = (label: string) => {
    const match = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
    if (!match) throw new Error(`找不到按钮 ${label}`)
    return match
  }
  try {
    await act(() => root.render(
      <AccessModePicker agent="codex" mode="default" inheritedMode="default" supported disabled={false} onChange={onChange} />,
    ))
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="访问模式"]')
    button('完全访问').focus()
    await act(() => button('完全访问').click())
    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
    expect(onChange).not.toHaveBeenCalled()

    const menuClosing = new Event('closeAutoFocus', { cancelable: true })
    closeMenu?.(menuClosing)
    expect(menuClosing.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)

    await act(() => button('取消').click())
    expect(document.activeElement).toBe(trigger)
    expect(onChange).not.toHaveBeenCalled()
    const ordinaryMenuClosing = new Event('closeAutoFocus', { cancelable: true })
    closeMenu?.(ordinaryMenuClosing)
    expect(ordinaryMenuClosing.defaultPrevented).toBe(false)
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
