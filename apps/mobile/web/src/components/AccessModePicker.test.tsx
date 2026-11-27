// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AccessModePicker } from './AccessModePicker'

it('切换只读立即生效，完全访问需要再次确认', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const dialog = HTMLDialogElement.prototype
  const show = Object.getOwnPropertyDescriptor(dialog, 'showModal')
  const close = Object.getOwnPropertyDescriptor(dialog, 'close')
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const change = vi.fn()
  const click = (text: string) => {
    const button = [...host.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === text ||
        (!item.hasAttribute('aria-label') && item.textContent?.startsWith(text)))
    if (!button) throw new Error(`缺少按钮 ${text}`)
    return act(() => button.click())
  }

  try {
    await act(() => root.render(<AccessModePicker agent="codex" mode="inherit" effectiveMode="readOnly" inheritedMode="readOnly" supported disabled={false} onChange={change} />))
    expect(host.querySelector('.qn-access-chip')?.textContent).toBe('只读')
    await click('访问模式：继承总控 · 只读')
    expect(host.querySelector('dialog button[aria-pressed="true"]')?.textContent).toContain('继承总控')
    await click('只读')
    expect(change).toHaveBeenCalledWith('readOnly')
    change.mockClear()

    await click('访问模式：继承总控 · 只读')
    await click('完全访问')
    expect(host.querySelector('dialog')?.getAttribute('aria-label')).toBe('启用完全访问？')
    expect(change).not.toHaveBeenCalled()
    await click('取消')
    await click('完全访问')
    await click('启用')
    expect(change).toHaveBeenCalledExactlyOnceWith('fullAccess')

    await act(() => root.render(<AccessModePicker agent="codex" mode="fullAccess" effectiveMode="fullAccess" inheritedMode="readOnly" supported disabled={false} onChange={change} />))
    expect(host.querySelector('.qn-access-chip')?.textContent).toBe('完全访问')
    expect(host.querySelector('[aria-label="访问模式：完全访问"]')?.getAttribute('data-tone')).toBe('danger')
    change.mockClear()
    await click('访问模式：完全访问')
    await click('继承总控')
    expect(change).toHaveBeenCalledExactlyOnceWith('inherit')

    change.mockClear()
    await act(() => root.render(<AccessModePicker agent="codex" mode="default" effectiveMode="default" inheritedMode="default" supported={false} disabled={false} onChange={change} />))
    expect(host.querySelector('.qn-access-chip svg.lucide-shield')).not.toBeNull()
    expect(host.querySelector('.qn-access-chip')?.textContent).toBe('')
    await click('访问模式：Agent 默认权限')
    expect(host.querySelector('dialog')?.textContent).toContain('当前电脑或目标服务版本暂不支持会话权限覆盖。')
    const unsupported = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]:disabled')]
    expect(unsupported).toHaveLength(2)
    expect(unsupported.every((button) => button.disabled)).toBe(true)
    await click('只读')
    expect(change).not.toHaveBeenCalled()
    await act(() => host.querySelector<HTMLButtonElement>('dialog button[aria-pressed="true"]')?.click())
    expect(change).toHaveBeenCalledExactlyOnceWith('default')

    await act(() => root.render(<AccessModePicker agent="pi" mode="inherit" effectiveMode="default" inheritedMode="default" supported={false} disabled={false} onChange={change} />))
    expect(host.querySelector('button')).toBeNull()
  } finally {
    await act(() => root.unmount())
    for (const [name, descriptor] of [['showModal', show], ['close', close]] as const) {
      if (descriptor) Object.defineProperty(dialog, name, descriptor)
      else Reflect.deleteProperty(dialog, name)
    }
    vi.unstubAllGlobals()
  }
})
