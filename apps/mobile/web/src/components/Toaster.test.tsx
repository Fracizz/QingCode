// @vitest-environment jsdom
import { addEnglishMessages, setLocale } from '@qn/codex-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import mobile from '../i18n/mobile.en'
import { useApp } from '../store'
import { clearToasts, toast } from '../toast'
import { Toaster } from './Toaster'

it('接管全局 notice / error 悬浮显示，到时自动关闭，可点关闭和操作按钮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  const initial = useApp.getState()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(() => root.render(<Toaster />))
    expect(host.querySelector('.qn-toaster')).toBeNull()

    await act(() => useApp.setState({ notice: '队列已暂停', error: '连接失败' }))
    expect(host.querySelector('[data-tone="warn"]')?.textContent).toContain('队列已暂停')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('连接失败')
    // notice 是一次性提示，显示后即清空；error 仍保留给页面判断失败状态。
    expect(useApp.getState()).toMatchObject({ notice: null, error: '连接失败' })

    await act(() => vi.advanceTimersByTime(4000))
    expect(host.querySelector('[data-tone="warn"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    await act(() => vi.advanceTimersByTime(1000))
    expect(host.querySelector('.qn-toaster')).toBeNull()

    const onAction = vi.fn()
    await act(() => { toast('已断开', { duration: 0, actionLabel: '重连', onAction }) })
    await act(() => host.querySelector<HTMLButtonElement>('.qn-note-action')!.click())
    expect(onAction).toHaveBeenCalledOnce()
    expect(host.querySelector('.qn-toaster')).toBeNull()

    await act(() => { toast('可手动关闭', { duration: 0 }) })
    await act(() => host.querySelector<HTMLButtonElement>('.qn-note-close')!.click())
    expect(host.querySelector('.qn-toaster')).toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    clearToasts()
    useApp.setState(initial, true)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('英文界面翻译跨进程提示与悬浮提示按钮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  addEnglishMessages(mobile)
  setLocale('en')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(() => root.render(<Toaster />))
    await act(() => { toast('连接失败', { tone: 'error', duration: 0, actionLabel: '重试', onAction: vi.fn() }) })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Connection failed')
    expect(host.querySelector('.qn-note-action')?.textContent).toBe('Retry')
    expect(host.querySelector('.qn-note-close')?.getAttribute('aria-label')).toBe('Dismiss')
  } finally {
    await act(() => root.unmount())
    host.remove()
    clearToasts()
    setLocale('zh')
    vi.unstubAllGlobals()
  }
})
