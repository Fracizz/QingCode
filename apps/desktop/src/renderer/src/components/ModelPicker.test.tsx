// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { useModels } from '../store/models'
import { ContextRing, ModelPicker, formatTokensPrecise } from './ModelPicker'

const { session } = vi.hoisted(() => ({ session: { opened: true, rpc: { request: vi.fn() } } }))
vi.mock('../store/codex', () => ({
  useCodex: (selector: (state: { sessions: Record<string, typeof session> }) => unknown) =>
    selector({ sessions: { 'pi:local': session } }),
}))
vi.mock('../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('./primitives', () => ({
  PopoverRoot: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
  // 渲染悬浮卡内容，便于断言详情。
  Tip: ({ label, children }: { label: ReactNode; children: ReactNode }) => <>{children}<div data-tip>{label}</div></>,
}))
vi.mock('./ui', () => ({
  EmptyState: () => null,
  ErrorNote: () => null,
  IconButton: ({ label, children }: { label: string; children: ReactNode }) => <button aria-label={label}>{children}</button>,
  Spinner: () => null,
}))

it('无上下文窗口时仍显示 Claude 和 pi 的单轮统计', () => {
  const tokenUsage = { last: { totalTokens: 128 }, modelContextWindow: null, estimated: true, estimatedCostUsd: 0.012 }
  const html = renderToStaticMarkup(<ContextRing tokenUsage={tokenUsage} />)
  expect(html).toContain('查看最近一轮用量')
  expect(html).toContain('128 tokens')
  expect(html).toContain('费用估算 $0.012')
  expect(html).not.toContain('上下文已用')
  expect(html).toContain('<svg')
})

it('有窗口时显示圆环，悬浮卡列出已用/窗口和进度条', () => {
  const tokenUsage = { last: { totalTokens: 126_700 }, modelContextWindow: 258_400 }
  const html = renderToStaticMarkup(<ContextRing tokenUsage={tokenUsage} onClick={() => undefined} />)
  expect(html).toContain('aria-label="上下文已用 49%"')
  expect(html).toContain('<svg')
  expect(html).toContain('126.7k/258.4k')
  expect(html).toContain('aria-valuenow="49"')
})

it('会话暂无用量时仍显示圆环，草稿无用量时不显示', () => {
  expect(renderToStaticMarkup(<ContextRing tokenUsage={undefined} onClick={() => undefined} />)).toContain('暂无会话用量')
  expect(renderToStaticMarkup(<ContextRing tokenUsage={undefined} />)).toBe('')
})

it('详情数字保留一位小数', () => {
  expect(formatTokensPrecise(950)).toBe('950')
  expect(formatTokensPrecise(12_000)).toBe('12k')
  expect(formatTokensPrecise(126_749)).toBe('126.7k')
  expect(formatTokensPrecise(1_250_000)).toBe('1.3M')
})

it('pi 草稿显示启动入口，会话启动后立即重取模型', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useModels.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const start = vi.fn()
  session.rpc.request
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [{ model: 'provider/model', displayName: '测试模型' }] })
  try {
    await act(() => root.render(
      <ModelPicker targetId="local" agent="pi" threadId={null} piDraft={{ start, starting: false, disabled: false }} />,
    ))
    expect(host.querySelector('button')?.textContent).toBe('启动 pi 以选择模型')
    expect(start).not.toHaveBeenCalled()
    await act(() => host.querySelector('button')?.click())
    expect(start).toHaveBeenCalledOnce()

    await act(() => root.render(<ModelPicker targetId="local" agent="pi" threadId="first" />))
    expect(session.rpc.request).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[aria-label="选择模型与推理强度"]')?.textContent).toContain('测试模型')
  } finally {
    await act(() => root.unmount())
    useModels.setState(original)
    vi.unstubAllGlobals()
  }
})
