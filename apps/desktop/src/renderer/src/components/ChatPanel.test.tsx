// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useCodex } from '../store/codex'
import { ChatPanel } from './ChatPanel'
import { TooltipProvider } from './primitives'
import { RenderBoundary } from './RenderBoundary'

it.each([null, 'existing-thread'])('发送纯文本后仍可继续输入（会话 %s）', async (threadId) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initialState = useCodex.getState()
  const send = vi.fn<typeof initialState.send>(async (_text, options) => {
    if (!useCodex.getState().currentThreadId) {
      options?.onThreadCreated?.('new-thread')
      useCodex.setState({ currentThreadId: 'new-thread' })
    }
    return true
  })
  useCodex.setState({ currentTargetId: 'local', currentThreadId: threadId, send })
  const host = document.body.appendChild(document.createElement('div'))
  const onCaughtError = vi.fn()
  const root = createRoot(host, { onCaughtError })

  const typeMessage = (text: string) => act(() => {
    const input = host.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })

  try {
    await act(() => root.render(
      <RenderBoundary fallback={<p>桌面界面显示异常</p>}>
        <TooltipProvider>
          <ChatPanel onConnect={() => {}} onAddTarget={() => {}} />
        </TooltipProvider>
      </RenderBoundary>,
    ))
    await typeMessage('第一条消息')
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())

    expect(send).toHaveBeenCalledExactlyOnceWith('第一条消息', expect.objectContaining({
      input: [{ type: 'text', text: '第一条消息', text_elements: [] }],
    }))
    expect(onCaughtError).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')?.value).toBe('')
    await typeMessage('下一条消息')
    expect(host.querySelector('textarea')?.value).toBe('下一条消息')
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState(initialState, true)
    vi.unstubAllGlobals()
  }
})
