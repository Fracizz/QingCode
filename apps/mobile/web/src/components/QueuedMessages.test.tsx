// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useApp } from '../store'
import { clearToasts } from '../toast'
import { QueuedMessages } from './QueuedMessages'
import { Toaster } from './Toaster'

it('行内只留引导、更多、移除，新会话入口在更多面板中且需确认后发送', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useApp.getState()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const prototype = HTMLDialogElement.prototype
  const methods = Object.getOwnPropertyDescriptors(prototype)
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  const release = vi.fn()
  const send = vi.fn().mockResolvedValue(true)
  const message = { id: 'message', text: '排队正文', annotations: [], attachments: [], delegate: false, overrides: {} }
  const key = (agent: string) => JSON.stringify(['desktop', 'local', agent, 'thread'])
  const button = (text: string) => [...host.querySelectorAll('button')].find((item) =>
    (item.getAttribute('aria-label') ?? item.textContent) === text)!
  try {
    await act(() => {
      useApp.setState({
        activeId: 'desktop', selectedTargetId: 'local', selectedAgent: 'codex', selectedThreadId: 'thread',
        eventsConnected: true, queuedSends: { [key('codex')]: [message], [key('claude')]: [message] },
        beginQueuedEdit: () => release, sendQueuedInNewThread: send,
      })
      root.render(<><QueuedMessages running canSteer /><Toaster /></>)
    })
    expect([...host.querySelectorAll('li button')].slice(0, 3)
      .map((item) => item.getAttribute('aria-label') ?? item.textContent))
      .toEqual(['引导', '更多操作', '移除排队消息 1'])
    await act(() => button('更多操作').click())
    expect([...host.querySelectorAll('dialog button')].map((item) => item.textContent))
      .toEqual(expect.arrayContaining(['引导', '插入']))
    await act(() => button('新会话开始').click())
    expect(host.querySelector('dialog')?.textContent).toContain('从空白会话开始')
    await act(() => button('取消').click())
    expect(release).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    await act(() => button('更多操作').click())
    await act(() => button('新对话继续').click())
    expect(host.querySelector('dialog')?.textContent).toContain('继承已结束轮次的上下文')
    expect(send).not.toHaveBeenCalled()
    await act(() => button('在新会话发送').click())
    expect(release).toHaveBeenLastCalledWith(false)
    expect(send).toHaveBeenCalledExactlyOnceWith('message', 'continue')

    await act(() => useApp.setState({ selectedAgent: 'claude' }))
    await act(() => button('更多操作').click())
    await act(() => button('新对话继续').click())
    expect(host.querySelector('dialog')?.textContent).toContain('继承已结束轮次的上下文')
    expect(button('在新会话发送').disabled).toBe(false)

    vi.useFakeTimers()
    send.mockResolvedValueOnce('no-finished-turn')
    await act(() => button('在新会话发送').click())
    expect(host.querySelector('dialog')).toBeNull()
    expect(host.querySelector('.qn-toaster')?.textContent).toContain('当前还没有已结束的一轮')
    expect(host.querySelector('.qn-queue')?.textContent).not.toContain('当前还没有已结束的一轮')
    expect(host.querySelector('.qn-queue')?.textContent).toContain('排队正文')
    await act(() => vi.advanceTimersByTime(8000))
    expect(host.querySelector('.qn-toaster')).toBeNull()
  } finally {
    await act(() => root.unmount())
    clearToasts()
    vi.useRealTimers()
    for (const name of ['showModal', 'close']) {
      if (methods[name]) Object.defineProperty(prototype, name, methods[name])
      else Reflect.deleteProperty(prototype, name)
    }
    host.remove()
    useApp.setState(initial)
    vi.unstubAllGlobals()
  }
})
