// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FileActionsContext, isLongUserText, MessageItem, ToolGroup } from './MessageItem'

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

it('用户消息把技能写在正文开头，附件显示成标签', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const tags = () => [...host.querySelectorAll('.qn-user-skill')].map((tag) => tag.textContent)
  const body = () => host.querySelector('.qn-user-bubble > .whitespace-pre-wrap')?.textContent
  try {
    // Claude 回显与历史：技能写在正文开头，附件说明在末尾。
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'u',
      text: '/commit-push all 打包\n\n附件文件（请按需读取）：\n- a.ts: /work/src/a.ts' }} />))
    expect(tags()).toEqual(['/commit-push'])
    expect(body()).toBe('/commit-push all 打包')
    expect(host.querySelector('[title="/work/src/a.ts"]')?.textContent?.trim()).toBe('a.ts')
    // 来自 skill 输入项的标签之间及标签与正文之间各保留一个空格。
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'm', text: '继续检查', skills: ['pdf', 'review'] }} />))
    expect(tags()).toEqual(['/pdf', '/review'])
    expect(body()).toBe('/pdf /review 继续检查')
    // 只发技能时气泡里只有技能名。
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 's', text: '', skills: ['pdf'] }} />))
    expect(tags()).toEqual(['/pdf'])
    expect(body()).toBe('/pdf')
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'p', text: '打开 /tmp/a' }} />))
    expect(tags()).toEqual([])
    expect(body()).toBe('打开 /tmp/a')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('后台任务摘要过长时标题只占两行，全文收进展开区', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const summary = `状态栏文档摘要 ${'很长的内容'.repeat(30)} **结尾**`
  try {
    await act(() => root.render(<MessageItem item={{ kind: 'backgroundTask', id: 'task', status: 'completed', summary, result: '' }} />))
    const title = host.querySelector('summary span')!
    expect(title.className).toContain('line-clamp-2')
    expect(host.querySelector('strong')).toBeNull()
    await toggle(host.querySelector('summary')!)
    expect(host.querySelector('.qn-markdown strong')?.textContent).toBe('结尾')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('用户长消息超过 8 行或 600 字折叠，可展开收起；短消息不折叠', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  expect(isLongUserText('短消息')).toBe(false)
  expect(isLongUserText('行\n'.repeat(8))).toBe(true)
  expect(isLongUserText('字'.repeat(601))).toBe(true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'u', text: '日志\n'.repeat(20) }} />))
    const toggle = host.querySelector<HTMLButtonElement>('.qn-fold-toggle')!
    expect(host.querySelector('.line-clamp-8')).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(() => toggle.click())
    expect(host.querySelector('.line-clamp-8')).toBeNull()
    expect(toggle.textContent).toBe('收起')
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'short', text: '你好' }} />))
    expect(host.querySelector('.qn-fold-toggle')).toBeNull()
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
    expect(time.textContent).toBe('23:58:00')
    expect(time.dateTime).toBe(completed.toISOString())
    expect(time.nextElementSibling?.classList.contains('qn-markdown')).toBe(true)
    await act(() => vi.advanceTimersByTime(1000))
    expect(host.querySelector('time')?.textContent).toBe('2026-11-26 23:58:00')
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
    const onResend = vi.fn().mockResolvedValue(true)
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'own', text }} onQuote={onQuote} onResend={onResend}
      resendNote="将从上一轮分出新会话发送，原会话保留。" />))
    // 与电脑版一致：气泡下常驻复制、编辑。
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(['复制消息', '编辑消息'])
    await act(async () => buttons()[0]!.click())
    expect(writeText).toHaveBeenLastCalledWith(text)
    // 不改内容也能提交，即原样重发；分支重发显示说明和对应按钮文案。
    await act(() => buttons()[1]!.click())
    expect(host.textContent).toContain('将从上一轮分出新会话发送，原会话保留。')
    expect(action('在新分支发送').disabled).toBe(false)
    // host 未挂到文档上，jsdom 不会因点击提交按钮触发表单提交，直接派发 submit。
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onResend).toHaveBeenCalledWith(text, [])
    // 不能编辑时（如运行中）只剩复制。
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'own', text }} onQuote={onQuote} />))
    expect(buttons()).toHaveLength(1)
    expect(host.querySelector('[aria-label="编辑消息"]')).toBeNull()
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'own', text }} onQuote={onQuote} onResend={onResend} />))
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
