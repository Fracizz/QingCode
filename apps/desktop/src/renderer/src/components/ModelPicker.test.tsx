// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useModels } from '../store/models'
import { ModelPicker } from './ModelPicker'

const { session } = vi.hoisted(() => ({ session: { opened: true, rpc: { request: vi.fn() } } }))
vi.mock('../store/codex', () => ({
  useCodex: (selector: (state: { sessions: Record<string, typeof session> }) => unknown) =>
    selector({ sessions: { 'pi:local': session } }),
}))
vi.mock('../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('./primitives', () => ({
  PopoverRoot: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: () => null,
  Tip: () => null,
}))
vi.mock('./ui', () => ({ EmptyState: () => null, ErrorNote: () => null, Spinner: () => null }))

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
