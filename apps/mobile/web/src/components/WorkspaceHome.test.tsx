// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { App } from '../App'
import { useMobilePreferences } from '../mobilePreferences'
import { useApp } from '../store'
import { useWorkspace, type WorkspaceThread } from '../workspace'
import { WorkspaceHome } from './WorkspaceHome'

it('每个项目默认显示 6 个会话，设置为 10 后仍可展开其余会话', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const app = useApp.getState()
  const workspace = useWorkspace.getState()
  const preferences = useMobilePreferences.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const desktopId = 'preview-desktop'
  const project = { id: 'demo', targetId: 'local', name: '示例项目', path: '/demo', lastOpenedAt: 0 }
  const threads = Array.from({ length: 12 }, (_, index): WorkspaceThread => ({
    id: `thread-${index}`, title: `会话 ${index + 1}`, preview: '', cwd: project.path,
    updatedAt: index, agent: 'codex', targetId: project.targetId, projectId: project.id,
  }))
  const rows = () => host.querySelectorAll('.qn-thread-row')
  const more = () => host.querySelector<HTMLButtonElement>('.qn-session-more')!

  try {
    await act(() => {
      useApp.setState({ activeId: desktopId, eventsConnected: false })
      useWorkspace.setState({
        tab: 'sessions',
        projects: { [desktopId]: { loading: false, error: false, loaded: true, items: [project] } },
        threads: { [desktopId]: threads },
      })
      root.render(<WorkspaceHome />)
    })
    expect(rows()).toHaveLength(6)
    expect(more().textContent).toBe('显示更多（6 条）')

    await act(() => useMobilePreferences.setState({ sessionPreviewCount: 10 }))
    expect(rows()).toHaveLength(10)
    expect(more().textContent).toBe('显示更多（2 条）')
    await act(() => more().click())
    expect(rows()).toHaveLength(12)
    await act(() => more().click())
    expect(rows()).toHaveLength(10)
  } finally {
    await act(() => root.unmount())
    useApp.setState(app)
    useWorkspace.setState(workspace)
    useMobilePreferences.setState(preferences)
    vi.unstubAllGlobals()
  }
})

it('连接状态跨标签页更新，持续失联只显示一条提示', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const app = useApp.getState()
  const workspace = useWorkspace.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const activeTab = () => host.querySelector('nav button[aria-current="page"]')?.textContent
  const selectTab = (name: string) => [...host.querySelectorAll('nav button')]
    .find((button) => button.textContent === name) as HTMLButtonElement
  const loadProjects = vi.fn().mockResolvedValue(undefined)
  const warning = '暂时无法连接电脑，正在自动重试。'

  try {
    await act(() => {
      useApp.setState({
        page: 'workspace',
        booting: false,
        activeId: 'desktop',
        connections: [{ id: 'desktop', name: '测试电脑', host: '127.0.0.1', port: 38500,
          desktopName: '测试电脑', token: '', fp: '', createdAt: 0 }],
        eventsConnected: true,
        connectionLatencyMs: { desktop: 368 },
        init: () => () => undefined,
        loadTargets: vi.fn().mockResolvedValue(undefined),
        refreshStatuses: vi.fn().mockResolvedValue(undefined),
      })
      useWorkspace.setState({ loadProjects })
      root.render(<App />)
    })

    // 会话页顶部不再放大标题、电脑延迟和设置按钮，这些统一放在「连接」页。
    expect(activeTab()).toBe('会话')
    expect(host.querySelector('h1')).toBeNull()
    expect(host.textContent).not.toContain('368 ms')
    expect(host.querySelector('[aria-label="应用设置"]')).toBeNull()
    const refreshes = loadProjects.mock.calls.length
    await act(() => useApp.setState({ eventsConnected: false }))
    expect(host.textContent).not.toContain('368 ms')
    expect(host.textContent).not.toContain(warning)
    expect(loadProjects).toHaveBeenCalledTimes(refreshes)

    // 连上过的电脑短暂失联不打扰：5 秒内恢复就不提示，持续 5 秒才显示。
    await act(() => useApp.setState({ eventsError: warning }))
    await act(() => vi.advanceTimersByTime(4000))
    expect(host.textContent).not.toContain(warning)
    await act(() => useApp.setState({ eventsError: null }))
    await act(() => vi.advanceTimersByTime(5000))
    expect(host.textContent).not.toContain(warning)
    await act(() => useApp.setState({ eventsError: warning }))
    await act(() => vi.advanceTimersByTime(4999))
    expect(host.textContent).not.toContain(warning)
    await act(() => vi.advanceTimersByTime(1))
    const notice = host.querySelector('[role="status"]')
    expect(notice?.textContent).toContain(warning)
    await act(() => selectTab('项目').click())
    expect(activeTab()).toBe('项目')
    expect(host.querySelector('h1')).toBeNull()
    expect(host.textContent).not.toContain('368 ms')
    expect(host.querySelector('[aria-label="应用设置"]')).toBeNull()
    await act(() => selectTab('连接').click())
    expect(activeTab()).toBe('连接')
    expect(host.querySelector('h1')?.textContent).toBe('QingCode')
    expect(host.querySelector('[aria-label="应用设置"]')).not.toBeNull()
    expect(host.textContent).toContain('测试电脑')
    expect(host.textContent).not.toContain('368 ms')
    expect(host.querySelector('[role="status"]')).toBe(notice)
    expect(host.textContent?.split(warning)).toHaveLength(2)
    // 恢复后提示至少停留 2 秒再消失。
    await act(() => vi.advanceTimersByTime(500))
    await act(() => useApp.setState({ eventsConnected: true, eventsError: null }))
    expect(host.textContent).toContain(warning)
    expect(host.textContent).toContain('368 ms')
    await act(() => vi.advanceTimersByTime(1500))
    expect(host.textContent).not.toContain(warning)
  } finally {
    await act(() => root.unmount())
    useApp.setState(app)
    useWorkspace.setState(workspace)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('从纵向主机列表切换项目筛选并恢复全部项目', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const dialog = HTMLDialogElement.prototype
  const methods = {
    showModal(this: HTMLDialogElement) { this.open = true },
    close(this: HTMLDialogElement) { this.open = false },
  }
  const originals = Object.entries(methods).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(dialog, name)
    Object.defineProperty(dialog, name, { value, configurable: true })
    return { name, descriptor }
  })
  const app = useApp.getState()
  const workspace = useWorkspace.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-expanded]')
  const option = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('dialog button[aria-pressed]')]
    .find((button) => button.textContent === text)

  try {
    await act(() => {
      useApp.setState({
        activeId: 'desktop',
        loadTargets: vi.fn().mockResolvedValue(undefined),
        targets: [
          { id: 'local', name: '本机', kind: 'local' },
          { id: 'direct', name: 'CI 主机', kind: 'direct', host: 'ci.test', port: 47390 },
        ],
      })
      useWorkspace.setState({
        tab: 'projects',
        loadProjects: vi.fn().mockResolvedValue(undefined),
        projects: { desktop: { loading: false, error: false, loaded: true, items: [
          { id: 'a', targetId: 'local', name: '本地项目', path: '/local/a', lastOpenedAt: 0 },
          { id: 'b', targetId: 'direct', name: '远端项目', path: '/srv/b', lastOpenedAt: 0 },
        ] } },
      })
      root.render(<WorkspaceHome />)
    })

    expect(trigger()?.textContent).toContain('全部主机')
    expect(host.textContent).toContain('本地项目')
    expect(host.textContent).toContain('远端项目')
    expect(host.textContent).toContain('直连 · CI 主机')
    expect(option('CI 主机')).toBeUndefined()
    await act(() => trigger()?.click())
    expect(option('全部主机')?.getAttribute('aria-pressed')).toBe('true')
    await act(() => option('CI 主机')?.click())
    expect(trigger()?.textContent).toContain('CI 主机')
    expect(host.querySelector('dialog')).toBeNull()
    expect(host.textContent).not.toContain('本地项目')
    expect(host.textContent).toContain('远端项目')
    await act(() => trigger()?.click())
    expect(option('CI 主机')?.getAttribute('aria-pressed')).toBe('true')
    await act(() => option('全部主机')?.click())
    expect(host.textContent).toContain('本地项目')
  } finally {
    await act(() => root.unmount())
    useApp.setState(app)
    useWorkspace.setState(workspace)
    for (const { name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(dialog, name, descriptor)
      else Reflect.deleteProperty(dialog, name)
    }
    vi.unstubAllGlobals()
  }
})
