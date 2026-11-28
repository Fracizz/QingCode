// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { readChatFont } from '../chatFont'
import { setGateway } from '../client'
import { useMobileAppearance, useMobilePreferences } from '../mobilePreferences'
import { Composer } from './Composer'
import { MobileSettings } from './MobileSettings'

it('常用设置即时应用并保存，对话继承原有字号且选词时不发送', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const systemScheme = Object.assign(new EventTarget(), { matches: true })
  vi.stubGlobal('matchMedia', vi.fn(() => systemScheme))
  const initial = useMobilePreferences.getState()
  const dialog = HTMLDialogElement.prototype
  const originalDialog = Object.getOwnPropertyDescriptors(dialog)
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const send = vi.fn(async () => true)
  const noop = () => {}

  function Harness({ settings }: { settings: boolean }) {
    useMobileAppearance()
    return settings ? <MobileSettings onClose={noop} /> : (
      <Composer draftKey="settings-test" text="待发送" onChangeText={noop} onSend={send}
        annotations={[]} quoteDraft={null} onConfirmQuote={noop} onCancelQuote={noop}
        onUpdateAnnotation={noop} onRemoveAnnotation={noop} onInterrupt={noop}
        running={false} sending={false} canSteer={false} />
    )
  }

  function click(label: string) {
    const button = [...host.querySelectorAll('button')]
      .find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label)
    if (!button) throw new Error(`缺少按钮 ${label}`)
    return act(() => button.click())
  }

  // 选项行点开后在弹层里选；选完弹层关闭，行内显示新值。
  async function choose(title: string, option: string) {
    const row = [...host.querySelectorAll('.qn-setting-row')]
      .find((item) => item.querySelector('.qn-setting-title')?.textContent === title)
    if (!(row instanceof HTMLButtonElement)) throw new Error(`缺少设置行 ${title}`)
    await act(() => row.click())
    const radio = [...document.querySelectorAll('[role="radio"]')].find((item) => item.textContent === option)
    if (!(radio instanceof HTMLButtonElement)) throw new Error(`缺少选项 ${option}`)
    await act(() => radio.click())
    expect(document.querySelector('[role="radio"]')).toBeNull()
    expect(row.querySelector('.qn-setting-value')?.textContent).toBe(option)
  }

  try {
    localStorage.setItem('qn.mobile.chatFontSize', '21')
    await act(() => root.render(<Harness settings />))
    expect(host.querySelector('output')?.textContent).toBe('21 px')
    await click('放大对话字号')
    expect(host.querySelector('output')?.textContent).toBe('22 px')
    expect(readChatFont()).toBe(22)
    await choose('主题', '浅色')
    await choose('界面动效', '减少动效')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(true)

    const followSystem = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="跟随系统深色模式"]')!
    expect(followSystem.getAttribute('aria-checked')).toBe('false')
    await act(() => followSystem.click())
    expect(followSystem.getAttribute('aria-checked')).toBe('true')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(JSON.parse(localStorage.getItem('qn.mobile.preferences') ?? 'null')).toMatchObject({ theme: 'light', followSystemDark: true })
    const changeSystemDark = (matches: boolean) => act(() => {
      systemScheme.matches = matches
      systemScheme.dispatchEvent(new Event('change'))
    })
    await changeSystemDark(false)
    expect(document.documentElement.dataset.theme).toBe('light')
    await changeSystemDark(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    await act(() => followSystem.click())
    expect(document.documentElement.dataset.theme).toBe('light')

    await choose('每个项目默认显示的会话数', '10')
    await choose('发送按键', '回车发送')
    expect(JSON.parse(localStorage.getItem('qn.mobile.preferences') ?? 'null')).toEqual({
      theme: 'light', followSystemDark: false, reduceMotion: true, sendKey: 'send', runningSendMode: 'queue', imageCompression: 'medium',
      sessionPreviewCount: 10,
    })
    await choose('图片压缩', '高（体积最小）')
    expect(JSON.parse(localStorage.getItem('qn.mobile.preferences') ?? 'null')).toMatchObject({ imageCompression: 'high' })
    await act(() => root.render(<Harness settings={false} />))
    const input = host.querySelector('textarea')!
    const enter = (options?: KeyboardEventInit) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }))
    expect(input.getAttribute('enterkeyhint')).toBe('send')
    await act(() => {
      expect(enter({ shiftKey: true })).toBe(true)
      expect(enter({ isComposing: true })).toBe(true)
      expect(enter({ repeat: true })).toBe(false)
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      expect(enter()).toBe(true)
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    expect(send).not.toHaveBeenCalled()
    await act(() => { expect(enter()).toBe(false) })
    expect(send).toHaveBeenCalledExactlyOnceWith('待发送', [], 'queue')

    await act(() => useMobilePreferences.getState().update({ sendKey: 'newline' }))
    await act(() => {
      expect(enter()).toBe(true)
      expect(enter({ ctrlKey: true })).toBe(false)
    })
    expect(send).toHaveBeenCalledTimes(2)
  } finally {
    await act(() => root.unmount())
    useMobilePreferences.setState(initial)
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.removeAttribute('data-reduce-motion')
    host.remove()
    for (const method of ['showModal', 'close'] as const) {
      if (originalDialog[method]) Object.defineProperty(dialog, method, originalDialog[method])
      else Reflect.deleteProperty(dialog, method)
    }
    vi.unstubAllGlobals()
  }
})

it.each([false, true])('Android 启动和主题回调同步页面与系统栏（先收到回调：%s）', async (pushBeforeReply) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useMobilePreferences.getState()
  const previousCallback = window.__qnNativeCallback
  let themeRequestId: number | undefined
  const setBars = vi.fn()
  const reply = (id: number, result: boolean) => window.__qnNativeCallback?.(JSON.stringify({ id, ok: true, result }))
  vi.stubGlobal('QnNative', {
    request(json: string) {
      const { id, method, params } = JSON.parse(json)
      if (method === 'appearance.systemTheme') themeRequestId = id
      if (method === 'appearance.systemBars') {
        setBars(params.light)
        queueMicrotask(() => reply(id, params.light))
      }
      return '{"queued":true}'
    },
  })
  setGateway(null)
  useMobilePreferences.setState({ theme: 'light', followSystemDark: true })
  const root = createRoot(document.createElement('div'))

  function Harness() {
    useMobileAppearance()
    return null
  }

  try {
    await act(() => root.render(<Harness />))
    expect(themeRequestId).toBeDefined()
    if (pushBeforeReply) await act(() => window.__qnSystemTheme?.(false))
    await act(() => reply(themeRequestId!, pushBeforeReply))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(setBars).toHaveBeenLastCalledWith(false)

    await act(() => window.__qnSystemTheme?.(true))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(setBars).toHaveBeenLastCalledWith(true)
    await act(() => window.__qnSystemTheme?.(false))
    await act(() => useMobilePreferences.setState({ theme: 'gray' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    await act(() => window.__qnSystemTheme?.(true))
    expect(document.documentElement.dataset.theme).toBe('gray')
    expect(setBars).toHaveBeenLastCalledWith(false)
  } finally {
    await act(() => root.unmount())
    setGateway(null)
    if (previousCallback) window.__qnNativeCallback = previousCallback
    else delete window.__qnNativeCallback
    useMobilePreferences.setState(initial)
    delete document.documentElement.dataset.theme
    document.documentElement.removeAttribute('data-reduce-motion')
    vi.unstubAllGlobals()
  }
  expect(window.__qnSystemTheme).toBeUndefined()
})
