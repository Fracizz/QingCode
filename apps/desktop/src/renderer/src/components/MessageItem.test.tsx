// @vitest-environment jsdom
import type { ItemView } from '@qn/codex-client'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LoadingIcon } from './LoadingIcon'
import { MessageItem, ToolGroup, TurnProgress, WorkGroup } from './MessageItem'

vi.mock('../features/files', () => ({
  createMarkdownLink: () => 'a', FileChangeActions: () => null, PathText: () => null, qnUrlTransform: (url: string) => url,
}))
vi.mock('../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('../store/codex', () => ({ useCodex: () => null }))
vi.mock('./CodeBlock', () => ({ CodeBlock: () => null }))
vi.mock('./MessageActions', () => ({ MessageActions: () => null }))
vi.mock('./SubagentDetails', () => ({ SubagentDetails: () => null }))
vi.mock('./ui', () => ({ Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>, IconButton: () => null }))

const toggle = (summary: HTMLElement) => act(async () => {
  summary.click()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
})

it('没有摘要时只显示进行中的思考提示，收到摘要后可以展开', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const reasoning = { kind: 'reasoning', id: 'r', summary: ' \n', streaming: true } as const
  try {
    await act(() => root.render(<MessageItem item={reasoning} />))
    expect(host.textContent).toBe('正在思考…')
    expect(host.querySelector('details')).toBeNull()

    await act(() => root.render(<MessageItem item={{ ...reasoning, streaming: false }} />))
    expect(host.firstElementChild).toBeNull()

    await act(() => root.render(<MessageItem item={{ ...reasoning, streaming: false, summary: '已确认修改位置' }} />))
    const summary = host.querySelector('summary')!
    expect(summary.textContent).toBe('思考过程')
    expect(host.textContent).not.toContain('已确认修改位置')
    await toggle(summary)
    expect(host.textContent).toContain('已确认修改位置')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('工具组和处理提示共用加载圆环，完成或中断后换回状态图标', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const command: ItemView = { kind: 'command', id: 'cmd', command: '测试命令', status: 'inProgress', output: '' }
  try {
    await act(() => root.render(<>
      <LoadingIcon />
      <ToolGroup items={[command]} />
      <TurnProgress />
    </>))
    const reference = host.querySelector('svg')!.outerHTML
    expect(reference).toContain('viewBox="0 0 12 12"')
    expect(host.querySelector('summary svg')?.outerHTML).toBe(reference)
    expect(host.querySelector('[role="status"]')?.previousElementSibling?.querySelector('svg')?.outerHTML).toBe(reference)

    await act(() => root.render(<>
      <ToolGroup items={[{ ...command, status: 'completed' }]} />
      <TurnProgress activity="interrupted" />
    </>))
    expect(host.innerHTML).not.toContain(reference)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('本轮已中断')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('把最终回复时间放在工作摘要右侧，简单回复在正文上方显示', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 1, 0, 15))
  const host = document.createElement('div')
  const root = createRoot(host)
  const reply: ItemView = { kind: 'agent', id: 'reply', text: '已完成', streaming: false, completedAtMs: new Date(2025, 11, 31, 23, 58).getTime() }
  try {
    await act(() => root.render(<>
      <WorkGroup durationMs={360_000} entries={[]} replyCompletedAtMs={reply.completedAtMs} />
      <MessageItem item={reply} replyTimeInSummary />
    </>))
    expect(host.querySelector('summary')?.textContent).toContain('工作了 6m 0s')
    expect(host.querySelector('summary time')?.textContent).toBe('2025-12-31 23:58')
    expect(host.querySelectorAll('time')).toHaveLength(1)
    await act(() => root.render(<MessageItem item={reply} />))
    expect(host.querySelector('time')?.nextElementSibling?.classList.contains('qn-markdown')).toBe(true)
  } finally {
    await act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('折叠工作过程和工具组不会挂载历史详情，展开工具组按批显示', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const readOutput = vi.fn(() => '执行结果')
  const items: ItemView[] = Array.from({ length: 61 }, (_, index) => ({
    kind: 'command', id: `cmd-${index}`, command: `测试命令 ${index}`, status: 'completed',
    get output() { return readOutput() },
  }))
  const button = (text: string) => [...host.querySelectorAll('button')].find((entry) => entry.textContent === text)!
  try {
    await act(() => root.render(<WorkGroup durationMs={1000} entries={[
      { kind: 'tools', key: 'tools', items },
      { kind: 'item', key: 'notes', item: { kind: 'agent', id: 'notes', text: '**历史说明**', streaming: false } },
    ]} />))
    const workSummary = host.querySelector('summary')!
    expect(host.querySelectorAll('details')).toHaveLength(1)
    expect(host.querySelector('strong')).toBeNull()
    expect(readOutput).not.toHaveBeenCalled()

    await toggle(workSummary)
    expect(host.querySelector('strong')?.textContent).toBe('历史说明')
    expect(host.querySelectorAll('details')).toHaveLength(2)
    expect(readOutput).not.toHaveBeenCalled()

    await toggle(host.querySelectorAll('summary')[1]!)
    expect(host.querySelectorAll('details')).toHaveLength(32)
    expect(readOutput).not.toHaveBeenCalled()
    await toggle(host.querySelectorAll('summary')[2]!)
    expect(host.querySelector('pre')?.textContent).toBe('执行结果')

    await act(() => button('下一批').click())
    expect(host.querySelectorAll('details')).toHaveLength(32)
    expect(host.querySelector('pre')).toBeNull()
    expect(host.querySelectorAll('summary')[2]?.textContent).toContain('测试命令 30')
    await act(() => button('上一批').click())
    expect(host.querySelectorAll('summary')[2]?.textContent).toContain('测试命令 0')

    await toggle(workSummary)
    expect(host.querySelectorAll('details')).toHaveLength(1)
    expect(host.querySelector('strong')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('只在展开桌面文件改动时读取差异和行数', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const readDiff = vi.fn(() => '@@ -1 +1 @@\n-旧内容\n+新内容')
  try {
    await act(() => root.render(<MessageItem item={{
      kind: 'fileChange', id: 'change', status: 'completed', changes: [
        { path: 'test.txt', kind: 'update', get diff() { return readDiff() } },
      ],
    }} />))
    expect(readDiff).not.toHaveBeenCalled()
    const summary = host.querySelector('summary')!
    await toggle(summary)
    expect(host.querySelector('pre')?.textContent).toContain('+新内容')
    expect(host.textContent).toContain('test.txt')
    expect(host.textContent).toContain('−1')
    await toggle(summary)
    expect(host.querySelector('pre')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
