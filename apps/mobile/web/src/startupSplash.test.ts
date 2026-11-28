// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMobilePreferences } from './mobilePreferences'
import { startSplash } from './startupSplash'
import { useApp } from './store'

const preferences = useMobilePreferences.getState()
const app = useApp.getState()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  useApp.setState({ booting: true })
  document.body.innerHTML = '<div id="qn-splash"><div class="qn-splash-status"></div></div><div id="root" inert></div>'
})

afterEach(() => {
  useApp.setState(app)
  useMobilePreferences.setState(preferences)
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
  document.documentElement.removeAttribute('data-reduce-motion')
  vi.useRealTimers()
})

it('本地数据快速就绪时仍完成标志入场，再显示完成态并解除交互锁定', () => {
  const splash = document.getElementById('qn-splash')!
  const root = document.getElementById('root')!
  startSplash(root)
  useApp.setState({ booting: false })
  vi.advanceTimersByTime(999)
  expect(splash.textContent).toBe('正在启动')
  expect(root.hasAttribute('inert')).toBe(true)
  vi.advanceTimersByTime(1)
  expect(splash.textContent).toBe('准备就绪')
  expect(splash.hasAttribute('data-ready')).toBe(true)
  expect(splash.hasAttribute('data-leaving')).toBe(false)
  vi.advanceTimersByTime(180)
  expect(splash.hasAttribute('data-leaving')).toBe(true)
  vi.advanceTimersByTime(520)
  expect(splash.isConnected).toBe(false)
  expect(root.hasAttribute('inert')).toBe(false)
})

it('本地数据一直未就绪时，超时后淡出且不显示就绪', () => {
  const splash = document.getElementById('qn-splash')!
  startSplash(document.getElementById('root')!)
  vi.advanceTimersByTime(7999)
  expect(splash.hasAttribute('data-leaving')).toBe(false)
  vi.advanceTimersByTime(1)
  expect(splash.hasAttribute('data-ready')).toBe(false)
  expect(splash.hasAttribute('data-leaving')).toBe(true)
  vi.advanceTimersByTime(520)
  expect(document.getElementById('root')?.hasAttribute('inert')).toBe(false)
})

it('减少动效时仍保留 500 毫秒展示和淡出', () => {
  useMobilePreferences.setState({ reduceMotion: true })
  const splash = document.getElementById('qn-splash')!
  const root = document.getElementById('root')!
  startSplash(root)
  useApp.setState({ booting: false })
  vi.advanceTimersByTime(499)
  expect(splash.hasAttribute('data-leaving')).toBe(false)
  vi.advanceTimersByTime(1)
  expect(splash.hasAttribute('data-leaving')).toBe(true)
  vi.advanceTimersByTime(499)
  expect(root.hasAttribute('inert')).toBe(true)
  vi.advanceTimersByTime(1)
  expect(root.hasAttribute('inert')).toBe(false)
})
