// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useApp } from '../store'
import { UsageHome } from './UsagePage'

const initial = useApp.getState()

afterEach(() => {
  useApp.setState(initial)
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
