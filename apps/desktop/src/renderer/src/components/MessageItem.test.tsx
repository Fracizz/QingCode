// @vitest-environment jsdom
import type { ItemView } from '@qn/codex-client'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LoadingIcon } from './LoadingIcon'
import { MessageItem, ToolGroup, TurnProgress, TurnStopped, WorkGroup } from './MessageItem'

const renderCodeBlock = vi.hoisted(() => vi.fn())

vi.mock('../features/files', () => ({
  createMarkdownLink: () => 'a', FileChangeActions: () => null, PathText: () => null, qnUrlTransform: (url: string) => url,
}))
vi.mock('../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('../store/codex', () => ({ useCodex: () => null }))
vi.mock('./CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => {
    renderCodeBlock(code)
    return null
  },
}))
vi.mock('./MessageActions', () => ({ MessageActions: () => null }))
vi.mock('./SubagentDetails', () => ({ SubagentDetails: () => null }))
vi.mock('./ui', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  IconButton: ({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>{children}</button>
  ),
}))

const toggle = (summary: HTMLElement) => act(async () => {
  summary.click()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
})

it('后台任务独立显示状态，展开后按 Markdown 显示完整结果', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(() => root.render(<MessageItem item={{
      kind: 'backgroundTask', id: 'task', status: 'completed', summary: '手机后台提醒', result: '**类型检查通过**',
    }} onEdit={vi.fn()} />))
    const summary = host.querySelector('summary')!
    expect(summary.textContent).toContain('后台任务已完成 · 手机后台提醒')
    expect(host.textContent).not.toContain('类型检查通过')
    await toggle(summary)
    expect(host.querySelector('strong')?.textContent).toBe('类型检查通过')
    expect(host.querySelector('button[aria-label*="编辑"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('对话更新操作回调时复用历史回复的 Markdown，正文变化时重新渲染', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  renderCodeBlock.mockClear()
  const root = createRoot(document.createElement('div'))
  const reply: ItemView = { kind: 'agent', id: 'reply', text: '```text\n历史内容\n```', streaming: false }
  const render = (item: ItemView) => act(() => root.render(
    <MessageItem item={item} onFork={() => () => {}} onEdit={async () => true} />,
  ))
  try {
    await render(reply)
    await render(reply)
    expect(renderCodeBlock.mock.calls).toEqual([['历史内容\n']])
    await render({ ...reply, text: '```text\n更新后的内容\n```' })
    expect(renderCodeBlock.mock.calls).toEqual([['历史内容\n'], ['更新后的内容\n']])
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('用户消息用圆角标签显示技能，并用一个空格隔开标签与正文', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const render = (text: string, skills?: string[]) => act(() => root.render(
    <MessageItem item={{ kind: 'user', id: 'user', text, skills }} />,
  ))
  const labels = () => [...host.querySelectorAll('.qn-user-skill')].map((label) => label.textContent)
  const body = () => host.querySelector('.bg-qn-bubble')?.textContent
  try {
    await render('/commit-push all')
    expect(labels()).toEqual(['/commit-push'])
    expect(body()).toBe('/commit-push all')
    await render('继续检查', ['pdf', 'review'])
    expect(labels()).toEqual(['/pdf', '/review'])
    expect(body()).toBe('/pdf /review 继续检查')
    await render('', ['pdf'])
    expect(labels()).toEqual(['/pdf'])
    expect(body()).toBe('/pdf')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('收到无效的发送时间时仍显示用户消息', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    const item: ItemView = { kind: 'user', id: 'user', text: '继续检查', sentAt: 1e16 }
    await act(() => root.render(<MessageItem item={item} />))
    expect(host.textContent).toContain(item.text)
    expect(host.querySelector('time')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('流式 Markdown 解析失败时显示原文，保留其他消息并在结束时重新渲染', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const onCaughtError = vi.fn()
  const root = createRoot(host, { onCaughtError })
  const text = '> '.repeat(6000) + '回复内容'
  const reply: ItemView = { kind: 'agent', id: 'reply', text, streaming: true }
  const render = (item: ItemView) => act(() => root.render(
    <>
      <MessageItem item={{ kind: 'user', id: 'user', text: '继续检查' }} />
      <MessageItem item={item} />
    </>,
  ))
  try {
    await render(reply)
    expect(onCaughtError).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('继续检查')
    expect(host.textContent).toContain(text)

    await render({ ...reply, text: text + '，仍在生成' })
    expect(host.textContent).toContain('仍在生成')
    expect(onCaughtError).toHaveBeenCalledTimes(1)

    await render({ ...reply, text: '**检查完成**', streaming: false })
    expect(host.querySelector('strong')?.textContent).toBe('检查完成')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('编辑消息时保留输入框的选区和焦点，并用修订后的文字发送', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onMessageMouseUp = vi.fn()
  const onEdit = vi.fn().mockResolvedValue(true)
  const item: ItemView = { kind: 'user', id: 'message', text: '五分钟刷一次' }
  try {
    await act(() => root.render(<div onMouseUp={onMessageMouseUp}><MessageItem item={item} onEdit={onEdit} /></div>))
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑消息"]')!.click())
    const area = host.querySelector('textarea')!
    const send = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(send.textContent).toBe('重新发送')
    expect(document.activeElement).toBe(area)
    expect(send.disabled).toBe(false)

    area.setSelectionRange(0, 3)
    area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    expect(onMessageMouseUp).not.toHaveBeenCalled()
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, 3])

    const focus = vi.spyOn(area, 'focus')
    const enter = (text: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
      area.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    await enter(' ')
    expect(send.disabled).toBe(true)
    const text = '十分钟刷一次'
    await enter(text)
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(area)
    expect(send.disabled).toBe(false)
    await act(() => send.click())
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(text, [{ type: 'text', text, text_elements: [] }])
    expect(host.querySelector('textarea')).toBeNull()
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('没有 onEdit 时不显示编辑按钮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'plain', text: '不支持修订的 Agent' }} />))
    expect(host.querySelector('[aria-label="编辑消息"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('不改内容也能直接重发原文和附件', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onEdit = vi.fn().mockResolvedValue(true)
  const text = '/review   检查改动\n\n附件文件（请按需读取）：\n- 说明: /project/readme.md'
  const image = { type: 'localImage', path: '/project/screenshot.png' } as const
  try {
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'original', text, inputExtras: [image] }} onEdit={onEdit} />))
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑消息"]')!.click())
    expect(host.querySelector('textarea')?.value).toBe('检查改动')
    await act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('检查改动', [{ type: 'text', text, text_elements: [] }, image])
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('对话中的虚拟图片名打开相应图片的预览', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const images = ['data:image/png;base64,AAAA', 'data:image/webp;base64,BBBB']
  try {
    await act(() => root.render(<MessageItem item={{ kind: 'user', id: 'original', text: '看看这两张图', images }} />))
    const thumbnails = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'))
    expect(thumbnails.map((button) => button.textContent)).toEqual(['[image.png]', '[image-2.webp]'])
    const dialogs = Array.from(host.querySelectorAll('dialog'))
    const first = vi.fn()
    const second = vi.fn()
    Object.assign(dialogs[0]!, { showModal: first })
    Object.assign(dialogs[1]!, { showModal: second })
    await act(() => thumbnails[1]!.click())
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(dialogs[1]?.querySelector('img')?.getAttribute('src')).toBe(images[1])
    expect(host.textContent).toContain('看看这两张图')
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
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

it('处理提示用加载圆环，命令组用闪烁的终端图标，停止后显示用时', async () => {
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
    // 命令组改用终端图标，运行中光标闪烁表示进行中。
    expect(host.querySelector('summary svg .qn-terminal-cursor')).not.toBeNull()
    expect(host.querySelector('[role="status"]')?.previousElementSibling?.querySelector('svg')?.outerHTML).toBe(reference)

    await act(() => root.render(<>
      <ToolGroup items={[{ ...command, status: 'completed' }]} />
      <TurnStopped durationMs={0} />
    </>))
    expect(host.innerHTML).not.toContain(reference)
    expect(host.querySelectorAll('summary > svg:first-child path')).toHaveLength(2)
    expect(host.querySelector('.qn-terminal-cursor')).toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('你已停止，已用时 0秒')
    await act(() => root.render(<TurnStopped durationMs={null} />))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('你已停止')
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
    expect(host.querySelector('summary time')?.textContent).toBe('2025-12-31 23:58:00')
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
