// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FileActionsContext, MessageItem, ToolGroup } from './MessageItem'

const toggle = (summary: HTMLElement) => act(async () => {
  summary.click()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
})

it('后台任务卡片支持触摸展开 Markdown 结果，只有摘要时直接显示', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const task = { kind: 'backgroundTask' as const, id: 'task', status: 'failed' as const, summary: '手机后台提醒' }
  try {
    await act(() => root.render(<MessageItem item={{ ...task, result: '' }} />))
    expect(host.textContent).toContain('后台任务失败 · 手机后台提醒')
    expect(host.querySelector('summary')).toBeNull()
    await act(() => root.render(<MessageItem item={{ ...task, result: '**类型检查失败**' }} />))
    expect(host.textContent).not.toContain('类型检查失败')
    await toggle(host.querySelector('summary')!)
    expect(host.querySelector('strong')?.textContent).toBe('类型检查失败')
    expect(host.querySelector('.qn-user-bubble')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('在回复上方显示完成时间，跨午夜后补上本地日期', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 26, 23, 59, 59))
  const completed = new Date(2026, 10, 26, 23, 58)
  const host = document.createElement('div')
  const root = createRoot(host)
  const reply = { kind: 'agent' as const, id: 'reply', text: '内容', completedAtMs: completed.getTime() }
  try {
    await act(() => root.render(<MessageItem item={{ ...reply, streaming: true }} />))
    expect(host.querySelector('time')).toBeNull()
    await act(() => root.render(<MessageItem item={{ ...reply, streaming: false }} />))
    const time = host.querySelector('time')!
    expect(time.textContent).toBe('23:58')
    expect(time.dateTime).toBe(completed.toISOString())
    expect(time.nextElementSibling?.classList.contains('qn-markdown')).toBe(true)
    await act(() => vi.advanceTimersByTime(1000))
    expect(host.querySelector('time')?.textContent).toBe('2026-11-26 23:58')
  } finally {
    await act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('消息操作菜单可引用、复制纯文本或 Markdown，自己的消息另有编辑入口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const dialogMethods = Object.entries({
    showModal(this: HTMLDialogElement) { this.open = true },
    close(this: HTMLDialogElement) { this.open = false },
  }).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)
    Object.defineProperty(HTMLDialogElement.prototype, name, { value, configurable: true })
    return { name, descriptor }
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const onQuote = vi.fn()
  const text = '**原文**'
  const buttons = () => [...host.querySelectorAll('button')]
  const toolbar = () => host.querySelector<HTMLButtonElement>('button[aria-label="消息操作"]')!
  const action = (label: string) => buttons().find((button) => button.textContent === label)!
  try {
    await act(() => root.render(<MessageItem item={{ kind: 'agent', id: 'reply', text, streaming: false }} onQuote={onQuote} />))
    expect(buttons()).toEqual([toolbar()])
    Object.defineProperty(host.querySelector('.qn-markdown')!, 'innerText', { value: '原文' })
    await act(() => toolbar().click())
    await act(async () => action('复制纯文本').click())
    expect(writeText).toHaveBeenLastCalledWith('原文')
    await act(async () => action('复制 Markdown 源文').click())
    expect(writeText).toHaveBeenLastCalledWith(text)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('已复制')
    await act(() => action('引用到对话').click())
    expect(onQuote).toHaveBeenCalledWith(text)
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'own', text }} onQuote={onQuote} onResend={vi.fn()} />))
    expect(buttons()).toHaveLength(0)
    await act(() => {
      host.querySelector('.qn-user-bubble')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(buttons().map((button) => button.textContent)).toEqual(expect.arrayContaining(['编辑并重发', '引用到对话', '复制文本']))
  } finally {
    await act(() => root.unmount())
    for (const { name, descriptor } of dialogMethods) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
    }
    vi.unstubAllGlobals()
  }
})

it('折叠时不读取命令输出，展开工具组只挂载当前一批', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const readOutput = vi.fn(() => '命令详情')
  const items = Array.from({ length: 61 }, (_, index) => ({
    kind: 'command' as const, id: `cmd-${index}`, command: `测试命令 ${index}`, status: 'completed',
    get output() { return readOutput() },
  }))
  const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text)!
  try {
    await act(() => root.render(<ToolGroup items={items} onQuote={vi.fn()} />))
    const groupSummary = host.querySelector('summary')!
    expect(host.querySelectorAll('details')).toHaveLength(1)
    expect(readOutput).not.toHaveBeenCalled()

    await toggle(groupSummary)
    expect(host.querySelectorAll('details.qn-tool')).toHaveLength(30)
    expect(readOutput).not.toHaveBeenCalled()

    await toggle(host.querySelector('details.qn-tool summary')!)
    expect(host.querySelector('pre')?.textContent).toBe('命令详情')
    expect(readOutput).toHaveBeenCalledOnce()
    expect(button('上一批').disabled).toBe(true)

    await act(() => button('下一批').click())
    expect(host.querySelectorAll('details.qn-tool')).toHaveLength(30)
    expect(host.querySelector('details.qn-tool summary')?.textContent).toContain('测试命令 30')
    expect(host.querySelector('pre')).toBeNull()

    await act(() => button('下一批').click())
    expect(host.querySelectorAll('details.qn-tool')).toHaveLength(1)
    expect(button('下一批').disabled).toBe(true)
    await act(() => button('上一批').click())
    expect(host.querySelectorAll('details.qn-tool')).toHaveLength(30)

    await toggle(groupSummary)
    expect(host.querySelectorAll('details')).toHaveLength(1)
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('展开文件改动后可预览并打开完整差异', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const openDiff = vi.fn()
  const diff = '@@ -1 +1 @@\n-旧内容\n+新内容'
  const readDiff = vi.fn(() => diff)
  try {
    await act(() => root.render(
      <FileActionsContext.Provider value={{ cwd: '/project', openFile: vi.fn(), openDiff }}>
        <MessageItem item={{ kind: 'fileChange', id: 'change', status: 'completed', changes: [
          { path: 'test.txt', kind: 'update', get diff() { return readDiff() } },
        ] }} />
      </FileActionsContext.Provider>,
    ))
    const summary = host.querySelector('summary')!
    expect(readDiff).not.toHaveBeenCalled()
    expect(host.querySelector('pre')).toBeNull()
    await toggle(summary)
    expect(host.querySelector('pre')?.textContent).toContain('+新内容')
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="查看 test.txt 的差异"]')!
    await act(() => button.click())
    expect(openDiff).toHaveBeenCalledWith('/project/test.txt', diff)
    await toggle(summary)
    expect(host.querySelector('pre')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
