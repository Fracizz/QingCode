// @vitest-environment jsdom
import { addEnglishMessages, setLocale } from '@qn/codex-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import shared from '../../../../../packages/codex-client/src/i18n/shared.en'
import { useApp } from '../store'
import { UsageHome } from './UsagePage'

const initial = useApp.getState()

afterEach(() => {
  setLocale('zh')
  useApp.setState(initial)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([
  ['zh', '请在运行 Codex 的设备上执行 codex login，使用 ChatGPT 账号登录后查看额度。', '请在运行 Codex 的设备上执行 codex login，使用 ChatGPT 账号登录后查看总用量。'],
  ['en', 'Run codex login on the device running Codex and sign in with a ChatGPT account to view your quota.', 'Run codex login on the device running Codex and sign in with a ChatGPT account to view total usage.'],
] as const)('用量页按 %s 显示 Codex 登录指引', async (locale, quotaHint, usageHint) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  addEnglishMessages(shared)
  setLocale(locale)
  useApp.setState({
    activeId: 'desktop',
    targets: [{ id: 'local', kind: 'local', name: 'Local' }],
    rateLimits: { local: {
      snapshot: null, account: null, loading: false, updatedAt: null,
      error: 'chatgpt authentication required to read rate limits',
      usageError: 'ChatGPT authentication required to read token usage.',
    } },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(() => root.render(<UsageHome />))
    await act(() => host.querySelector<HTMLButtonElement>('.qn-usage-host')!.click())
    expect([...host.querySelectorAll('.qn-usage-error')].map((node) => node.textContent)).toEqual([quotaHint, usageHint])
  } finally {
    await act(() => root.unmount())
    host.remove()
  }
})

it('用量页无大标题和刷新按钮，切页与下拉刷新各自防抖', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date'] })
  const loadTargets = vi.fn().mockResolvedValue(undefined)
  const loadAgentSettings = vi.fn().mockResolvedValue(undefined)
  useApp.setState({ activeId: 'desktop', eventsConnected: true, targets: [], loadTargets, loadAgentSettings })
  const host = document.createElement('div')
  document.body.append(host)

  async function enter() {
    const root = createRoot(host)
    await act(async () => root.render(<UsageHome />))
    return root
  }
  async function pull() {
    const main = host.querySelector('main')!
    const touch = async (type: string, clientY: number) => {
      const point = { identifier: 1, clientX: 80, clientY }
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, { touches: type === 'touchend' ? [] : [point], changedTouches: [point] })
      await act(async () => { main.dispatchEvent(event) })
    }
    await touch('touchstart', 60)
    await touch('touchmove', 180)
    await touch('touchend', 180)
  }

  let root = await enter()
  expect(host.querySelector('h1')).toBeNull()
  expect(host.querySelector('button')).toBeNull()
  expect(loadTargets).toHaveBeenCalledTimes(1)

  // 间隔内切走再切回不重复请求。
  await act(() => root.unmount())
  root = await enter()
  expect(loadTargets).toHaveBeenCalledTimes(1)

  await pull()
  await pull()
  expect(loadTargets).toHaveBeenCalledTimes(2)

  vi.setSystemTime(Date.now() + 6_000)
  await pull()
  expect(loadTargets).toHaveBeenCalledTimes(3)
  await act(() => root.unmount())
  root = await enter()
  expect(loadTargets).toHaveBeenCalledTimes(4)

  await act(() => root.unmount())
  host.remove()
})
