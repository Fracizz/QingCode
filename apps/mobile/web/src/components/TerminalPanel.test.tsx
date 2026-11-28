// @vitest-environment jsdom
import type { TermInfo } from '@qn/protocol'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { projectRpc } from '../projectApi'
import { useApp } from '../store'
import { TerminalPanel } from './TerminalPanel'

vi.mock('../projectApi', () => ({ projectRpc: vi.fn() }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 20
    options = { disableStdin: true }
    unicode = { activeVersion: '' }
    modes = { applicationCursorKeysMode: true }
    loadAddon() {}
    open() {}
    dispose() {}
    onData() { return { dispose() {} } }
    onBinary() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    onWriteParsed() { return { dispose() {} } }
  },
}))

it('打开时接回终端，可显式新建和切换，重开时接回上次选中的终端', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const dialog = HTMLDialogElement.prototype
  const dialogMethods = ['showModal', 'close'] as const
  const descriptors = dialogMethods.map((method) => Object.getOwnPropertyDescriptor(dialog, method))
  for (const method of dialogMethods) Object.defineProperty(dialog, method, { configurable: true, value: vi.fn() })
  const initial = useApp.getState()
  localStorage.clear()
  const project = { id: 'project', targetId: 'local', path: '/work', name: 'Work', lastOpenedAt: 1 }
  const existing: TermInfo = {
    termId: 'old', cwd: project.path, shell: '/bin/sh', args: [], pid: 1,
    backend: 'python', supportsResize: false, alive: true, lastSeq: 0,
    cols: 80, rows: 20, startedAt: 1,
  }
  const created = { ...existing, termId: 'new', startedAt: 2 }
  const tabs = [existing]
  const request = vi.mocked(projectRpc).mockImplementation(async (_project, method, params) => {
    if (method === 'mobile.term.list') return { terminals: [...tabs] }
    if (method === 'mobile.term.open') {
      tabs.push(created)
      return created
    }
    if (method === 'mobile.term.attach') return { ...(params?.termId === existing.termId ? existing : created), mode: 'replay', chunks: [] }
    if (method === 'mobile.term.write') return { acceptedBytes: atob(String(params?.data)).length }
    return {}
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const picker = () => host.querySelector<HTMLButtonElement>('button[aria-label="切换终端"]')!

  try {
    await act(() => {
      useApp.setState({ activeId: 'desktop', eventsConnected: true })
      root.render(<StrictMode><TerminalPanel project={project} /></StrictMode>)
    })
    expect(picker().textContent).toBe('终端 1')
    expect(request).toHaveBeenCalledWith(project, 'mobile.term.attach', { termId: 'old', sinceSeq: 0 }, 'desktop')
    expect(request.mock.calls.filter(([, method]) => method === 'mobile.term.open')).toHaveLength(0)

    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="新建终端"]')!.click())
    expect(picker().textContent).toBe('终端 2')
    expect(request).toHaveBeenCalledWith(project, 'mobile.term.attach', { termId: 'new', sinceSeq: 0 }, 'desktop')

    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="发送 上方向键"]')!.click())
    expect(request).toHaveBeenCalledWith(project, 'mobile.term.write', { termId: 'new', data: btoa('\x1bOA') }, 'desktop')

    await act(() => picker().click())
    const options = [...host.querySelectorAll<HTMLButtonElement>('dialog button[aria-pressed]')]
    expect(options.map((option) => [option.textContent, option.getAttribute('aria-pressed')])).toEqual([
      ['终端 1sh', 'false'], ['终端 2sh', 'true'],
    ])
    await act(() => options[0]!.click())
    expect(host.querySelector('dialog')).toBeNull()
    expect(picker().textContent).toBe('终端 1')
    expect(request).toHaveBeenCalledWith(project, 'mobile.term.attach', { termId: 'old', sinceSeq: 0 }, 'desktop')

    await act(() => useApp.setState({ eventsConnected: false }))
    await act(() => useApp.setState({ eventsConnected: true }))
    expect(picker().textContent).toBe('终端 1')
    await act(() => picker().click())
    await act(() => host.querySelectorAll<HTMLButtonElement>('dialog button[aria-pressed]')[1]!.click())
    await act(() => root.render(null))
    await act(() => root.render(<StrictMode><TerminalPanel project={project} /></StrictMode>))
    expect(request.mock.calls.filter(([, method]) => method === 'mobile.term.open')).toHaveLength(1)
    expect(picker().textContent).toBe('终端 2')
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial, true)
    request.mockReset()
    localStorage.clear()
    vi.unstubAllGlobals()
    dialogMethods.forEach((method, index) => {
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(dialog, method, descriptor)
      else Reflect.deleteProperty(dialog, method)
    })
  }
})

it('新建失败后点重试，会再次请求新建终端', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useApp.getState()
  const project = { id: 'project', targetId: 'windows', path: 'C:/work', name: 'Work', lastOpenedAt: 1 }
  const request = vi.mocked(projectRpc).mockImplementation(async (_project, method) => {
    if (method === 'mobile.term.list') return { terminals: [] }
    throw new Error('Windows ConPTY 启动超时')
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(() => {
      useApp.setState({ activeId: 'desktop', eventsConnected: true })
      root.render(<TerminalPanel project={project} />)
    })
    expect(request.mock.calls.map(([, method]) => method)).toEqual(['mobile.term.list'])
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="新建终端"]')!.click())
    expect(host.textContent).toContain('Windows ConPTY 启动超时')
    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '重试')
    expect(retry).toBeDefined()
    await act(() => retry?.click())
    expect(request.mock.calls.map(([, method]) => method)).toEqual([
      'mobile.term.list', 'mobile.term.open', 'mobile.term.open',
    ])
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial, true)
    request.mockReset()
    vi.unstubAllGlobals()
  }
})

it.each([
  ['terminal_disabled', '请在电脑的手机连接设置中启用手机终端', '请在电脑「设置 → 手机连接」中启用项目终端，然后重试。'],
  ['forbidden', '该方法不在手机网关白名单内', '当前电脑版本不支持手机终端，请更新电脑端。'],
  ['forbidden', '终端不属于当前设备或项目', '终端不属于当前设备或项目'],
  ['method', '未知方法: term.list', '项目主机的服务版本不支持终端。请从电脑重新连接项目主机后重试。'],
])('旧端或权限错误 %s 时保留项目入口并给出对应提示', async (code, message, hint) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useApp.getState()
  const request = vi.mocked(projectRpc).mockRejectedValue(Object.assign(new Error(message), { code }))
  const project = { id: 'project', targetId: 'local', path: '/work', name: 'Work', lastOpenedAt: 1 }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(() => {
      useApp.setState({ activeId: 'desktop', eventsConnected: true })
      root.render(<TerminalPanel project={project} />)
    })
    expect(host.textContent).toContain(hint)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="新建终端"]')?.disabled).toBe(true)
    expect(request.mock.calls.map(([, method]) => method)).toEqual(['mobile.term.list'])
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial, true)
    request.mockReset()
    vi.unstubAllGlobals()
  }
})
