// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ContextUsage } from './ContextUsage'

it('无用量数据也能打开压缩入口，只有确认按钮发送请求', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const dialog = HTMLDialogElement.prototype
  const methods = ['showModal', 'close'] as const
  const descriptors = methods.map((method) => Object.getOwnPropertyDescriptor(dialog, method))
  for (const method of methods) Object.defineProperty(dialog, method, { configurable: true, value: vi.fn() })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onConfirm = vi.fn()
  const button = (name: string) => [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  const click = async (name: string) => {
    const target = button(name)
    expect(target).toBeDefined()
    await act(() => target?.click())
  }

  try {
    await act(() => root.render(<ContextUsage tokenUsage={null} compact={{ busy: false, blockedReason: null, onConfirm }} />))
    await click('查看上下文，暂无上下文用量')
    await click('压缩会话')
    expect(host.querySelector('[aria-label="确认压缩会话"]')).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()
    await click('取消')
    expect(onConfirm).not.toHaveBeenCalled()
    await click('压缩会话')
    await click('确认压缩')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(host.querySelector('dialog')).toBeNull()

    const tokenUsage = { last: { totalTokens: 128 }, modelContextWindow: null, estimated: true, estimatedCostUsd: 0.012 }
    await act(() => root.render(<ContextUsage tokenUsage={tokenUsage} />))
    await click('查看会话用量')
    const usage = host.querySelector('[aria-label="会话用量"]')
    expect(usage?.textContent).toContain('128 tokens')
    expect(usage?.textContent).toMatch(/费用估算 .*0\.012/)
    expect(usage?.querySelector('progress')).toBeNull()
    expect(host.querySelector('[data-testid="context-ring"]')).toBeNull()

    // 有窗口大小时按钮与电脑版一样显示占用环，不再显示百分比文字。
    await act(() => root.render(<ContextUsage tokenUsage={{ last: { totalTokens: 160_000 }, modelContextWindow: 200_000 }} />))
    const ring = host.querySelector('[data-testid="context-ring"]')
    expect(ring?.querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray')).toBe('80 100')
    expect(ring?.parentElement?.className).toContain('text-qn-warn')
    expect(button('查看上下文，上下文已用 80%')?.textContent).toBe('')
  } finally {
    await act(() => root.unmount())
    host.remove()
    methods.forEach((method, index) => {
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(dialog, method, descriptor)
      else Reflect.deleteProperty(dialog, method)
    })
    vi.unstubAllGlobals()
  }
})
