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
    loadAddon() {}
    open() {}
    dispose() {}
    onData() { return { dispose() {} } }
    onBinary() { return { dispose() {} } }
  },
}))

it('打开项目终端时新建并选中一个会话，重连后接回同一个会话', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useApp.getState()
  const project = { id: 'project', targetId: 'local', path: '/work', name: 'Work', lastOpenedAt: 1 }
  const existing: TermInfo = {
    termId: 'old', cwd: project.path, shell: '/bin/sh', args: [], pid: 1,
    backend: 'python', supportsResize: false, alive: true, lastSeq: 0,
    cols: 80, rows: 20, startedAt: 1,
  }
  const created = { ...existing, termId: 'new', startedAt: 2 }
  const tabs = [existing]
  const request = vi.mocked(projectRpc).mockImplementation(async (_project, method) => {
    if (method === 'mobile.term.list') return { terminals: [...tabs] }
    if (method === 'mobile.term.open') {
      tabs.push(created)
      return created
    }
    if (method === 'mobile.term.attach') return { ...created, mode: 'replay', chunks: [] }
    return {}
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const select = () => host.querySelector<HTMLSelectElement>('select[aria-label="切换终端"]')

  try {
    await act(() => {
      useApp.setState({ activeId: 'desktop', eventsConnected: true })
      root.render(<StrictMode><TerminalPanel project={project} /></StrictMode>)
    })
    expect(request).toHaveBeenCalledWith(project, 'mobile.term.open', { cols: 80, rows: 20 }, 'desktop')
    expect(select()?.value).toBe('new')
    expect(Array.from(select()!.options, (option) => option.value)).toEqual(['old', 'new'])
    expect(request).toHaveBeenCalledWith(project, 'mobile.term.attach', { termId: 'new', sinceSeq: 0 }, 'desktop')
    expect(request).not.toHaveBeenCalledWith(project, 'mobile.term.attach', { termId: 'old', sinceSeq: 0 }, 'desktop')

    await act(() => useApp.setState({ eventsConnected: false }))
    await act(() => useApp.setState({ eventsConnected: true }))
    expect(request.mock.calls.filter(([, method]) => method === 'mobile.term.open')).toHaveLength(1)
    expect(select()?.value).toBe('new')
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial, true)
    request.mockReset()
    vi.unstubAllGlobals()
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
