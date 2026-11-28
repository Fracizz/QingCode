// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../store'
import type { Connection } from '../types'
import { useWorkspace, workspaceProjectKey, type WorkspaceThread } from '../workspace'
import { ConnectionsPage } from './ConnectionPages'
import { PullToRefresh } from './PullToRefresh'
import { WorkspaceHome } from './WorkspaceHome'

const start = { identifier: 1, clientX: 80, clientY: 60 }
const down = { ...start, clientY: 180 }

function touch(target: Element, type: string, changed: typeof start, touches = [changed]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { touches, changedTouches: [changed] })
  target.dispatchEvent(event)
  return event
}

function pull(node: Element, end = down) {
  touch(node, 'touchstart', start)
  touch(node, 'touchmove', end)
  touch(node, 'touchend', end, [])
}

let host: HTMLDivElement
let root: Root
const initialApp = useApp.getState()
const initialWorkspace = useWorkspace.getState()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  useApp.setState(initialApp)
  useWorkspace.setState(initialWorkspace)
  vi.unstubAllGlobals()
})

describe('下拉刷新手势', () => {
  it('拉过阈值后松手刷新，等待期间只发起一次请求', async () => {
    let finish!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await act(() => root.render(<PullToRefresh label="列表" className="qn-body" onRefresh={refresh}>内容</PullToRefresh>))
    const main = host.querySelector('main')!
    await act(() => {
      touch(main, 'touchstart', start)
      expect(touch(main, 'touchmove', down).defaultPrevented).toBe(true)
    })
    expect(host.querySelector('[role="status"]')?.textContent).toBe('松手刷新')
    expect(refresh).not.toHaveBeenCalled()
    await act(() => touch(main, 'touchend', down, []))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('正在刷新…')
    await act(() => pull(main))
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(() => finish())
    expect(main.getAttribute('aria-busy')).toBe('false')
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('普通滚动、横滑、输入、弹层和取消的触摸不刷新', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    await act(() => root.render(
      <PullToRefresh label="列表" className="qn-body" onRefresh={refresh}>
        <input type="search" />
        <dialog open><p>弹层内容</p></dialog>
      </PullToRefresh>,
    ))
    const main = host.querySelector('main')!
    await act(() => {
      main.scrollTop = 80
      pull(main)
      main.scrollTop = 0
      pull(main, { ...start, clientY: 80 })
      pull(host.querySelector('input')!)
      pull(host.querySelector('dialog p')!)
      touch(main, 'touchstart', start)
      expect(touch(main, 'touchmove', { ...start, clientX: 15 }).defaultPrevented).toBe(false)
      touch(main, 'touchmove', down)
      touch(main, 'touchend', down, [])
      touch(main, 'touchstart', start)
      touch(main, 'touchmove', down)
      touch(main, 'touchcancel', down, [])
      touch(main, 'touchend', down, [])
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(host.querySelector('[role="status"]')).toBeNull()
  })
})

it.each([
  ['sessions', '会话'],
  ['projects', '项目'],
  ['connections', '连接'],
] as const)('%s Tab 下拉后刷新对应数据', async (tab, label) => {
  const connection: Connection = {
    id: 'desktop', host: '127.0.0.1', port: 38500, name: '电脑', desktopName: '电脑', token: '', fp: '', createdAt: 0,
  }
  const loadProjects = vi.fn().mockResolvedValue(undefined)
  const loadTargets = vi.fn().mockResolvedValue(undefined)
  const refreshStatuses = vi.fn().mockResolvedValue(undefined)
  useWorkspace.setState({ tab, loadProjects })
  useApp.setState({ activeId: connection.id, connections: [connection], booting: false, loadTargets, refreshStatuses })
  await act(() => root.render(tab === 'connections' ? <ConnectionsPage /> : <WorkspaceHome />))
  loadTargets.mockClear()
  loadProjects.mockClear()
  refreshStatuses.mockClear()
  await act(() => pull(host.querySelector(`main[aria-label="${label}"]`)!))
  if (tab === 'connections') {
    expect(refreshStatuses).toHaveBeenCalledTimes(1)
    expect(loadProjects).not.toHaveBeenCalled()
  } else {
    expect(loadTargets).toHaveBeenCalledTimes(1)
    expect(loadProjects).toHaveBeenCalledExactlyOnceWith(connection.id)
    expect(refreshStatuses).not.toHaveBeenCalled()
  }
  expect(useWorkspace.getState().tab).toBe(tab)
})

it('活动项目按最近活动时间排序，同一秒沿用固定顺序，只在启用或下拉刷新时更新', async () => {
  const desktopId = 'activity-desktop'
  const connection: Connection = {
    id: desktopId, host: '127.0.0.1', port: 38500, name: '电脑', desktopName: '电脑', token: '', fp: 'test', createdAt: 0,
  }
  const items = ['平时项目', '新结果项目', '运行项目', '置顶项目'].map((name, index) => ({
    id: String(index), targetId: 'local', name, path: `/project/${index}`, lastOpenedAt: 0,
  }))
  const rows: WorkspaceThread[] = items.map((project, index) => ({
    id: project.id, projectId: project.id, targetId: project.targetId, cwd: project.path, agent: 'codex',
    title: `会话 ${index}`, preview: '', updatedAt: index === 2 ? 1_000 : 2_000,
    activity: index === 2 ? 'running' : 'idle', unread: index === 1,
  }))
  const groupOrder = items.map(workspaceProjectKey)
  const preferences = { fp: connection.fp, groupOrder, pinnedProjects: [groupOrder[3]!], threads: {}, projectOrders: {} }
  useApp.setState({
    page: 'workspace', activeId: desktopId, connections: [connection],
    targets: [{ id: 'local', name: '本机', kind: 'local' }], loadTargets: vi.fn().mockResolvedValue(undefined),
  })
  useWorkspace.setState({
    tab: 'sessions', loadProjects: vi.fn().mockResolvedValue(undefined),
    projects: { [desktopId]: { items, loaded: true, loading: false, error: false } },
    preferences: { [desktopId]: preferences },
    threads: { [desktopId]: [...rows, { ...rows[2]!, id: 'newer', updatedAt: 3_000 }] },
  })
  const order = () => [...host.querySelectorAll('.qn-group-title h2')].map((heading) => heading.textContent)
  const option = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="项目排序"] button')]
    .find((button) => button.textContent === label)!

  await act(() => root.render(<WorkspaceHome />))
  expect(option('固定顺序').getAttribute('aria-pressed')).toBe('true')
  expect(order()).toEqual(['置顶项目', '平时项目', '新结果项目', '运行项目'])
  await act(() => option('活动优先').click())
  expect(option('活动优先').getAttribute('aria-pressed')).toBe('true')
  expect(order()).toEqual(['置顶项目', '运行项目', '新结果项目', '平时项目'])

  const simultaneous: WorkspaceThread[] = rows.map((thread) => ({ ...thread, unread: false,
    updatedAt: thread.id === '0' ? 10_100 : 10_900,
    activity: thread.id === '0' ? 'pending' : thread.id === '2' ? 'input' : 'idle',
  }))
  await act(() => useWorkspace.setState({ threads: { [desktopId]: simultaneous } }))
  expect(host.textContent).toContain('待审批')
  expect(order()).toEqual(['置顶项目', '运行项目', '新结果项目', '平时项目'])

  // 打开对话返回会重新挂载列表，活动顺序和已保存的滚动位置仍可对应。
  await act(() => root.render(null))
  await act(() => root.render(<WorkspaceHome />))
  expect(order()).toEqual(['置顶项目', '运行项目', '新结果项目', '平时项目'])
  await act(() => pull(host.querySelector('main')!))
  expect(order()).toEqual(['置顶项目', '平时项目', '运行项目', '新结果项目'])
  await act(() => useWorkspace.setState({ threads: { [desktopId]: [...simultaneous].reverse() } }))
  await act(() => pull(host.querySelector('main')!))
  expect(order()).toEqual(['置顶项目', '平时项目', '运行项目', '新结果项目'])

  await act(() => option('固定顺序').click())
  expect(order()).toEqual(['置顶项目', '平时项目', '新结果项目', '运行项目'])
  expect(useWorkspace.getState().preferences[desktopId]).toBe(preferences)
})
