// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { threadKey, type ThreadSummary } from '../../lib/threads'
import { useCodex } from '../../store/codex'
import { useThreadPrefs } from '../../store/threadPrefs'
import { TooltipProvider } from '../primitives'
import { ThreadRow } from './ThreadRow'

it.each([
  { agent: 'codex', label: 'Codex' },
  { agent: 'claude', label: 'Claude' },
  { agent: 'pi', label: 'pi' },
] as const)('会话行显示 $label 的图标', async ({ agent, label }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const thread: ThreadSummary = {
    id: 'thread', title: '拉取代码', preview: '', cwd: '/project', updatedAt: Date.now(), agent,
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)

  try {
    await act(() => root.render(
      <TooltipProvider>
        <ThreadRow thread={thread} targetId="local" current={false} onActivate={() => {}} />
      </TooltipProvider>,
    ))
    expect(host.querySelector(`[title="${label}"] > svg`)).toBeTruthy()
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('打开有新结果的会话后移除未读图标，同时保留当前会话选中态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const thread: ThreadSummary = {
    id: 'thread', title: '拉取代码', preview: '', cwd: '/project', updatedAt: Date.now(),
    agent: 'codex', activity: 'completed',
  }
  const targetId = 'local'
  const key = threadKey(thread.agent, thread.id)
  const { openThread } = useCodex.getState()
  const prefs = useThreadPrefs.getState()
  prefs.setUnread(targetId, key, true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (current: boolean) => root.render(
    <TooltipProvider>
      <ThreadRow thread={thread} targetId={targetId} current={current} onActivate={() => {}} />
    </TooltipProvider>,
  )
  const open = vi.fn(async () => {
    useThreadPrefs.getState().setUnread(targetId, key, false)
    render(true)
  })
  useCodex.setState({ openThread: open })

  try {
    await act(() => render(false))
    expect(host.querySelector('[aria-label="有新结果"] svg.lucide-check')).toBeTruthy()
    expect(host.querySelector('button')?.textContent).toBe(thread.title)

    await act(() => host.querySelector('button')!.click())
    expect(open).toHaveBeenCalledExactlyOnceWith(thread.id, thread.agent)
    expect(host.querySelector('button[aria-current="true"]')).toBeTruthy()
    expect(host.querySelector('[role="img"]')).toBeNull()

    await act(() => render(false))
    expect(host.querySelector('[role="img"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState({ openThread })
    useThreadPrefs.setState(prefs)
    vi.unstubAllGlobals()
  }
})
