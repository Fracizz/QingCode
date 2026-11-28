// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ContextUsage } from './ContextUsage'

it('无用量数据也能打开压缩入口，点压缩会话直接发送请求并关闭面板', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const dialog = HTMLDialogElement.prototype
  const methods = ['showModal', 'close'] as const
  const descriptors = methods.map((method) => Object.getOwnPropertyDescriptor(dialog, method))
  for (const method of methods) Object.defineProperty(dialog, method, { configurable: true, value: vi.fn() })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onCompact = vi.fn()
  const button = (name: string) => [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  const click = async (name: string) => {
    const target = button(name)
    expect(target).toBeDefined()
    await act(() => target?.click())
  }

  try {
    await act(() => root.render(<ContextUsage agent="codex" tokenUsage={null} compact={{ busy: false, blockedReason: null, onCompact }} />))
    await click('查看上下文，暂无上下文用量')
    expect(onCompact).not.toHaveBeenCalled()
    expect(host.querySelector('dialog')?.textContent).toContain('尚无用量数据')
    await click('压缩会话')
    expect(onCompact).toHaveBeenCalledTimes(1)
    expect(host.querySelector('dialog')).toBeNull()

    const tokenUsage = { last: { totalTokens: 128 }, modelContextWindow: null, estimated: true, estimatedCostUsd: 0.012 }
    await act(() => root.render(<ContextUsage agent="claude" tokenUsage={tokenUsage} />))
    await click('查看会话用量')
    const usage = host.querySelector('[aria-label="会话用量"]')
    expect(usage?.textContent).toContain('128 tokens')
    expect(usage?.textContent).not.toMatch(/费用|0\.012/)
    expect(usage?.querySelector('progress')).toBeNull()
    // 没有窗口大小时显示空环，保留相同的环径。
    expect(host.querySelector('[data-testid="context-ring"] circle:nth-of-type(2)')?.getAttribute('stroke-dasharray')).toBe('0 100')
    expect(button('查看会话用量')?.textContent).toBe('')

    for (const [percent, color] of [[0, 'text-qn-muted'], [80, 'text-qn-warn'], [100, 'text-qn-danger']] as const) {
      const usageWithWindow = { last: { totalTokens: percent }, modelContextWindow: 100, estimated: percent === 100 }
      await act(() => root.render(<ContextUsage agent="codex" tokenUsage={usageWithWindow} />))
      const ring = host.querySelector('[data-testid="context-ring"]')
      expect(ring?.getAttribute('width')).toBe('26')
      expect(ring?.querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray')).toBe(`${percent} 100`)
      expect(ring?.parentElement?.classList.contains(color)).toBe(true)
      expect(button(`查看上下文，上下文已用 ${percent}%`)?.textContent).toBe(String(percent))
    }

    await act(() => root.render(<ContextUsage agent="pi" tokenUsage={{
      last: { totalTokens: 8_000 }, total: { totalTokens: 1_250, inputTokens: 1_200, outputTokens: 50 },
      modelContextWindow: 10_000, estimated: true,
    }} thread={{ id: 'thread', status: 'running', activeTurnId: 'turn', pendingApprovals: [],
      items: [{ kind: 'other', type: 'dynamicToolCall', id: 'file', summary: 'read' }],
      turns: [{ id: 'turn', itemIds: ['file'], startedAtMs: null, durationMs: null }],
    }} />))
    const panel = host.querySelector('dialog')
    expect(panel?.querySelector('progress')?.value).toBe(80)
    expect(panel?.textContent).toContain('剩余2,000')
    expect(panel?.textContent).toContain('最近一轮用量1,250 tokens')
    expect(panel?.querySelector('[aria-label="本轮工具调用"]')?.textContent).toContain('read1')
    expect(panel?.textContent).not.toContain('使用建议')
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
