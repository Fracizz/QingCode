// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '@/types'

const mocks = vi.hoisted(() => {
  const state = {
    terminals: [] as TerminalTab[],
    activeTerminalId: 't1' as string | null,
    secondaryTerminalId: null,
    blTerminalId: null,
    brTerminalId: null,
    terminalFocusPane: 'primary',
    setTerminalFocusPane: vi.fn(),
    setActiveTerminal: vi.fn(),
    reorderTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    closeOtherTerminals: vi.fn(),
    closeAllProjectTerminals: vi.fn(),
    restartTerminal: vi.fn(),
    reopenTerminalShell: vi.fn(),
    renameTerminal: vi.fn(),
    addTerminal: vi.fn(),
  }
  const ui = {
    openTerminalPanel: vi.fn(),
    requestToggleTerminal: vi.fn(),
    requestSettings: vi.fn(),
  }
  const projectState = {
    currentProject: { id: 'p1', path: '/home/app', name: 'app' } as { id: string; path: string; name: string } | null,
    projects: [
      { id: 'p1', path: '/home/app', name: 'app' },
      { id: 'p2', path: '/home/api', name: 'api' },
      { id: 'p3', path: '/home/docs', name: 'docs' },
    ],
    sshConnections: [],
    reorderVisibleProjects: vi.fn(),
    addEmptyProject: vi.fn(),
    switchProject: vi.fn(),
    unavailableProjectIds: [] as string[],
    pushToast: vi.fn(),
  }
  return { state, ui, projectState }
})

const copyPathAction = vi.hoisted(() => vi.fn())
const busyTerminals = vi.hoisted(() => new Set<string>())

vi.mock('@/lib/terminal/terminalProgramActivity', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/terminal/terminalProgramActivity')>()),
  isTerminalProgramBusy: (id: string) => busyTerminals.has(id),
}))

vi.mock('../lib/copyFileActions', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/copyFileActions')>()),
  copyPathAction,
}))

vi.mock('../store/terminalStore', () => ({
  MAX_TERMINALS_PER_PROJECT: 10,
  terminalPaneOf: (terminal: TerminalTab) => terminal.pane ?? 'primary',
  useTerminalStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock('../store/projectStore', () => ({
  useProjectStore: Object.assign(
    (selector: (state: typeof mocks.projectState) => unknown) => selector(mocks.projectState),
    { getState: () => mocks.projectState },
  ),
}))

vi.mock('../store/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (state: typeof mocks.ui) => unknown) => selector(mocks.ui),
    { getState: () => mocks.ui },
  ),
}))

vi.mock('../lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values
        ? key.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
        : key,
  }),
}))

vi.mock('./Tooltip', () => ({
  default: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <span data-tooltip={label}>{children}</span>
  ),
}))

import TerminalSessionList from './TerminalSessionList'
import {
  markTerminalAttention,
  pruneTerminalAttention,
} from '@/lib/terminal/terminalAttention'

function terminal(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 't1',
    name: 'claude',
    projectId: 'p1',
    cwd: '/home/app',
    launchCommand: '',
    status: 'running',
    exitCode: null,
    persistent: false,
    ...overrides,
  }
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-terminal-session-row="${id}"]`) as HTMLElement
const group = (id: string) =>
  document.querySelector<HTMLElement>(`[data-terminal-project-group="${id}"]`) as HTMLElement

// jsdom 没有布局也没有 PointerEvent，这里补上元素位置和带 pointerId 的事件。
const layOut = (find: (id: string) => HTMLElement, spans: Record<string, [number, number]>) => {
  for (const [id, [top, bottom]] of Object.entries(spans)) {
    vi.spyOn(find(id), 'getBoundingClientRect').mockReturnValue({
      top,
      bottom,
      left: 0,
      right: 200,
      width: 200,
      height: bottom - top,
    } as DOMRect)
  }
}
const pointer = (type: string, target: EventTarget, clientY: number) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  act(() => {
    target.dispatchEvent(event)
  })
}
const dragFrom = (handle: HTMLElement, toY: number, fromY = 10) => {
  pointer('pointerdown', handle, fromY)
  pointer('pointermove', window, toY)
}
const release = () => pointer('pointerup', window, 0)

describe('TerminalSessionList', () => {
  // 拖动结束后吞 click 的监听在下一个宏任务才移除，不能漏到下一个用例。
  afterEach(() => new Promise<void>(resolve => { window.setTimeout(resolve, 0) }))

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    pruneTerminalAttention(new Set())
    mocks.projectState.currentProject = mocks.projectState.projects[0]
    mocks.projectState.unavailableProjectIds = []
    busyTerminals.clear()
    mocks.projectState.switchProject.mockResolvedValue(true)
    mocks.state.activeTerminalId = 't1'
    mocks.state.terminals = [
      terminal(),
      terminal({ id: 't2', name: 'dev', launchCommand: 'pnpm dev', pane: 'secondary' }),
      terminal({ id: 'other', name: 'elsewhere', projectId: 'p2' }),
    ]
  })

  it('groups the terminals of every project, regardless of pane', () => {
    render(<TerminalSessionList />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(within(group('p2')).getByText('elsewhere')).toBeInTheDocument()
    expect(group('p1')).toHaveAttribute('aria-current', 'true')
    expect(row('t1')).toHaveAttribute('aria-selected', 'true')
    expect(row('other')).toHaveAttribute('aria-selected', 'false')
    expect(row('t2').querySelector('[data-tooltip*="pnpm dev"]')).not.toBeNull()
    expect(document.querySelector('[title]')).toBeNull()
  })

  it('shows the source on the project header, the total only while collapsed, and marks the current project', () => {
    render(<TerminalSessionList />)
    expect(within(group('p1')).getByText('本机')).toBeInTheDocument()
    expect(group('p1').querySelector('[data-terminal-group-count]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开或收起「app」' }))
    expect(group('p1').querySelector('[data-terminal-group-count="p1"]')).toHaveTextContent('2')
    expect(group('p3').querySelector('[data-terminal-group-count]')).toBeNull()
    expect(group('p1').querySelector('[data-terminal-group-current="true"]')).not.toBeNull()
    expect(group('p2').querySelector('[data-terminal-group-current="true"]')).toBeNull()
  })

  it('tints the current project header only while no terminal row is highlighted', () => {
    render(<TerminalSessionList />)
    const header = group('p1').querySelector('[data-terminal-project-header]') as HTMLElement
    expect(header).not.toHaveClass('bg-brand/10')
    fireEvent.click(screen.getByRole('button', { name: '展开或收起「app」' }))
    expect(header).toHaveClass('bg-brand/10')
  })

  it('selects a terminal and reopens a collapsed terminal panel', () => {
    render(<TerminalSessionList />)
    fireEvent.click(row('t2'))
    expect(mocks.state.setActiveTerminal).toHaveBeenCalledWith('t2')
    expect(mocks.ui.openTerminalPanel).toHaveBeenCalledTimes(1)
  })

  it('switches project before activating a terminal from another project', async () => {
    render(<TerminalSessionList />)
    fireEvent.click(row('other'))
    expect(mocks.projectState.switchProject).toHaveBeenCalledWith(mocks.projectState.projects[1])
    await vi.waitFor(() => expect(mocks.state.setActiveTerminal).toHaveBeenCalledWith('other'))
    expect(mocks.ui.openTerminalPanel).toHaveBeenCalledTimes(1)
  })

  it('keeps the selection when the project switch is refused', async () => {
    mocks.projectState.switchProject.mockResolvedValue(false)
    render(<TerminalSessionList />)
    fireEvent.click(row('other'))
    await vi.waitFor(() => expect(row('other')).not.toHaveAttribute('aria-busy'))
    expect(mocks.state.setActiveTerminal).not.toHaveBeenCalled()
  })

  it('activates the last clicked terminal when one switch serves several clicks', async () => {
    let finish!: (value: boolean) => void
    mocks.projectState.switchProject.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve }))
    mocks.state.terminals = [
      terminal(),
      terminal({ id: 'other', name: 'elsewhere', projectId: 'p2' }),
      terminal({ id: 'other2', name: 'second', projectId: 'p2' }),
    ]
    render(<TerminalSessionList />)
    fireEvent.click(row('other'))
    fireEvent.click(row('other2'))
    expect(row('other2')).toHaveAttribute('aria-busy', 'true')
    expect(mocks.projectState.switchProject).toHaveBeenCalledTimes(1)
    finish(true)
    await vi.waitFor(() => expect(mocks.state.setActiveTerminal).toHaveBeenCalledWith('other2'))
    expect(mocks.state.setActiveTerminal).toHaveBeenCalledTimes(1)
  })

  it('moves the selection with the arrow keys inside the current project', () => {
    render(<TerminalSessionList />)
    fireEvent.keyDown(row('t1'), { key: 'ArrowDown' })
    expect(mocks.state.setActiveTerminal).toHaveBeenLastCalledWith('t2')
    expect(row('t2')).toHaveFocus()
  })

  it('only moves focus when the arrow keys reach another project', () => {
    render(<TerminalSessionList />)
    fireEvent.keyDown(row('t2'), { key: 'ArrowDown' })
    expect(row('other')).toHaveFocus()
    expect(mocks.projectState.switchProject).not.toHaveBeenCalled()
    fireEvent.keyDown(row('other'), { key: 'Enter' })
    expect(mocks.projectState.switchProject).toHaveBeenCalledTimes(1)
  })

  it('collapses a project, remembers it and hides its rows from the arrow keys', () => {
    const { unmount } = render(<TerminalSessionList />)
    fireEvent.click(within(group('p2')).getByRole('button', { name: '展开或收起「api」' }))
    expect(row('other')).toBeNull()
    fireEvent.keyDown(row('t2'), { key: 'ArrowDown' })
    expect(row('t1')).toHaveFocus()
    unmount()
    render(<TerminalSessionList />)
    expect(row('other')).toBeNull()
  })

  it('always expands the current project even if it was collapsed before', () => {
    localStorage.setItem('qingcode:terminal-list-collapsed', '["p1"]')
    render(<TerminalSessionList />)
    expect(row('t1')).not.toBeNull()
  })

  it('creates a terminal in another project after switching to it', async () => {
    render(<TerminalSessionList />)
    mocks.projectState.switchProject.mockImplementation(async (project: { id: string; path: string; name: string }) => {
      mocks.projectState.currentProject = project
      return true
    })
    fireEvent.click(within(group('p3')).getByRole('button', { name: '在「docs」新建终端' }))
    await vi.waitFor(() =>
      expect(mocks.state.addTerminal).toHaveBeenCalledWith('/home/docs', 'p3', undefined),
    )
  })

  it('shows a project without terminals as a header only', () => {
    render(<TerminalSessionList />)
    expect(within(group('p3')).queryByRole('tab')).toBeNull()
    expect(within(group('p3')).getByRole('button', { name: '展开或收起「docs」' })).toHaveAttribute('aria-disabled', 'true')
  })

  describe('project ordering', () => {
    const header = (id: string) =>
      document.querySelector<HTMLElement>(`[data-terminal-project-header="${id}"]`) as HTMLElement
    const groupIds = () =>
      [...document.querySelectorAll<HTMLElement>('[data-terminal-project-group]')].map(
        node => node.dataset.terminalProjectGroup,
      )

    it('keeps the project order when the current project changes', () => {
      mocks.projectState.currentProject = mocks.projectState.projects[2]
      render(<TerminalSessionList />)
      expect(groupIds()).toEqual(['p1', 'p2', 'p3'])
    })

    it('moves a project with its header and shows where it will land', () => {
      render(<TerminalSessionList />)
      layOut(group, { p1: [0, 40], p2: [50, 90], p3: [100, 140] })
      dragFrom(header('p1'), 130)
      expect(group('p1').className).toContain('opacity-45')
      expect(group('p3').querySelector('[data-terminal-project-drop="after"]')).not.toBeNull()
      release()
      expect(mocks.projectState.reorderVisibleProjects).toHaveBeenCalledWith(0, 2)
      expect(document.querySelector('[data-terminal-project-drop]')).toBeNull()
      expect(group('p1').className).not.toContain('opacity-45')
    })

    it('can start from the collapse button but not from the header actions', () => {
      render(<TerminalSessionList />)
      layOut(group, { p1: [0, 40], p2: [50, 90], p3: [100, 140] })
      dragFrom(within(header('p1')).getByRole('button', { name: '在「app」新建终端' }), 130)
      release()
      expect(mocks.projectState.reorderVisibleProjects).not.toHaveBeenCalled()
      dragFrom(within(header('p1')).getByRole('button', { name: '展开或收起「app」' }), 130)
      release()
      expect(mocks.projectState.reorderVisibleProjects).toHaveBeenCalledWith(0, 2)
    })

    it('does not collapse the project when the drag ends on its button', () => {
      render(<TerminalSessionList />)
      layOut(group, { p1: [0, 40], p2: [50, 90], p3: [100, 140] })
      const toggle = within(header('p1')).getByRole('button', { name: '展开或收起「app」' })
      dragFrom(toggle, 130)
      release()
      fireEvent.click(toggle)
      expect(row('t1')).not.toBeNull()
    })

    it('cancels with Escape and ignores a click that never moved', () => {
      render(<TerminalSessionList />)
      layOut(group, { p1: [0, 40], p2: [50, 90], p3: [100, 140] })
      dragFrom(header('p1'), 130)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      release()
      expect(document.querySelector('[data-terminal-project-drop]')).toBeNull()
      pointer('pointerdown', header('p1'), 10)
      release()
      expect(mocks.projectState.reorderVisibleProjects).not.toHaveBeenCalled()
    })

    it('does not reorder projects when a terminal row is dragged over another project', () => {
      render(<TerminalSessionList />)
      layOut(group, { p1: [0, 40], p2: [50, 90], p3: [100, 140] })
      dragFrom(row('t1'), 130)
      release()
      expect(document.querySelector('[data-terminal-project-drop]')).toBeNull()
      expect(mocks.projectState.reorderVisibleProjects).not.toHaveBeenCalled()
    })

    it('turns off project dragging in manage mode', () => {
      render(<TerminalSessionList />)
      layOut(group, { p1: [0, 40], p2: [50, 90], p3: [100, 140] })
      fireEvent.click(screen.getByRole('button', { name: '管理' }))
      dragFrom(header('p1'), 130)
      release()
      expect(mocks.projectState.reorderVisibleProjects).not.toHaveBeenCalled()
    })
  })

  it('does not activate a terminal of another project when arming its close button', () => {
    render(<TerminalSessionList />)
    fireEvent.click(within(row('other')).getByRole('button', { name: '关闭终端' }))
    expect(mocks.state.setActiveTerminal).not.toHaveBeenCalled()
    expect(within(row('other')).getByRole('button', { name: '确认关闭终端' })).toBeInTheDocument()
  })

  it('does not reorder onto a terminal of another project', () => {
    render(<TerminalSessionList />)
    layOut(row, { t1: [0, 28], t2: [30, 58], other: [100, 128] })
    dragFrom(row('t1'), 110)
    release()
    expect(mocks.state.reorderTerminal).not.toHaveBeenCalled()
  })

  it('keeps the creation time out of the row and in the hover details', () => {
    const today = new Date()
    today.setHours(9, 5, 0, 0)
    mocks.state.terminals = [terminal({ id: 'today', createdAt: today.getTime(), startedAt: Date.now() })]
    render(<TerminalSessionList />)
    expect(row('today')).not.toHaveTextContent('09:05')
    expect(row('today').querySelector('[data-tooltip*="09:05"]')).not.toBeNull()
  })

  it('keeps abnormal status text next to the close slot', () => {
    mocks.state.terminals = [terminal({ id: 'other', projectId: 'p2', status: 'exited', exitCode: 1 })]
    render(<TerminalSessionList />)
    expect(row('other').querySelector('[data-terminal-row-status="other"]')).toHaveTextContent('已退出')
  })

  it('dims terminals not restored yet without a dot, status text or restart', () => {
    mocks.state.terminals = [
      terminal({ id: 'other', name: 'waiting', projectId: 'p2', status: 'exited', awaitingRestoreSpawn: true }),
    ]
    render(<TerminalSessionList />)
    expect(row('other').querySelector('[data-terminal-activity]')).toBeNull()
    expect(within(row('other')).getByText('waiting')).toHaveClass('text-fg-muted')
    expect(within(row('other')).queryByText('待恢复')).toBeNull()
    expect(within(row('other')).queryByText('已退出')).toBeNull()
    expect(within(row('other')).queryByRole('button', { name: /重启/ })).toBeNull()
  })

  it('switches project before restarting an exited terminal of that project', async () => {
    mocks.state.terminals = [terminal({ id: 'other', projectId: 'p2', status: 'exited', exitCode: 1, launchCommand: 'pnpm dev' })]
    render(<TerminalSessionList />)
    fireEvent.click(within(row('other')).getByRole('button', { name: /重启/ }))
    expect(mocks.projectState.switchProject).toHaveBeenCalledWith(mocks.projectState.projects[1])
    await vi.waitFor(() => expect(mocks.state.reopenTerminalShell).toHaveBeenCalledWith('other'))
  })

  it('marks finished background terminals on the row and on a collapsed project', () => {
    markTerminalAttention('other')
    render(<TerminalSessionList />)
    expect(row('other').querySelector('[data-terminal-activity="attention"]')).not.toBeNull()
    expect(document.querySelector('[data-terminal-group-attention="p2"]')).toBeNull()
    fireEvent.click(within(group('p2')).getByRole('button', { name: '展开或收起「api」' }))
    expect(document.querySelector('[data-terminal-group-attention="p2"]')).not.toBeNull()
  })

  it('requires a second click before closing a running terminal', async () => {
    render(<TerminalSessionList />)
    const close = within(row('t1')).getByRole('button', { name: '关闭终端' })
    fireEvent.click(close)
    expect(mocks.state.closeTerminal).not.toHaveBeenCalled()
    fireEvent.click(within(row('t1')).getByRole('button', { name: '确认关闭终端' }))
    await vi.waitFor(() => expect(mocks.state.closeTerminal).toHaveBeenCalledWith('t1'))
  })

  it('does not select the row when its close button is used', () => {
    render(<TerminalSessionList />)
    fireEvent.click(within(row('t2')).getByRole('button', { name: '关闭终端' }))
    expect(mocks.ui.openTerminalPanel).not.toHaveBeenCalled()
  })

  it('renames in place from a double click', () => {
    render(<TerminalSessionList />)
    fireEvent.doubleClick(row('t2'))
    const input = screen.getByRole('textbox', { name: '重命名终端' })
    fireEvent.change(input, { target: { value: 'server' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.state.renameTerminal).toHaveBeenCalledWith('t2', 'server')
  })

  it('reorders along the vertical axis', () => {
    render(<TerminalSessionList />)
    layOut(row, { t1: [100, 140], t2: [150, 190], other: [300, 340] })
    dragFrom(row('t2'), 110, 170)
    release()
    expect(mocks.state.reorderTerminal).toHaveBeenLastCalledWith('t2', 't1', 'before')
    dragFrom(row('t2'), 130, 170)
    release()
    expect(mocks.state.reorderTerminal).toHaveBeenLastCalledWith('t2', 't1', 'after')
  })

  it('does not select a terminal when a drag ends on it', () => {
    render(<TerminalSessionList />)
    layOut(row, { t1: [100, 140], t2: [150, 190], other: [300, 340] })
    dragFrom(row('t2'), 110, 170)
    release()
    fireEvent.click(row('t2'))
    expect(mocks.state.setActiveTerminal).not.toHaveBeenCalled()
  })

  it('does not start a terminal drag from its close button', () => {
    render(<TerminalSessionList />)
    layOut(row, { t1: [100, 140], t2: [150, 190], other: [300, 340] })
    dragFrom(within(row('t2')).getByRole('button', { name: '关闭终端' }), 110, 170)
    release()
    expect(mocks.state.reorderTerminal).not.toHaveBeenCalled()
  })

  it('offers restart for an exited terminal', () => {
    mocks.state.terminals = [terminal({ status: 'exited', exitCode: 2 })]
    render(<TerminalSessionList />)
    expect(within(row('t1')).getByText('已退出')).toBeInTheDocument()
    expect(within(row('t1')).getByRole('button', { name: /重启/ })).toBeInTheDocument()
  })

  it('enters manage mode: rows toggle a selection instead of switching terminals', () => {
    render(<TerminalSessionList />)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    expect(screen.getByRole('button', { name: '完成' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('已选 0')
    expect(within(row('t1')).queryByRole('button', { name: '关闭终端' })).toBeNull()
    fireEvent.click(row('t2'))
    fireEvent.click(row('other'))
    expect(row('t2')).toHaveAttribute('aria-selected', 'true')
    expect(row('t1')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('已选 2')
    expect(mocks.projectState.switchProject).not.toHaveBeenCalled()
    expect(mocks.state.setActiveTerminal).not.toHaveBeenCalled()
    fireEvent.click(row('t2'))
    expect(screen.getByRole('status')).toHaveTextContent('已选 1')
  })

  it('selects all visible or only ended terminals and closes the selection', async () => {
    mocks.state.terminals = [
      terminal(),
      terminal({ id: 't2', name: 'dev', status: 'exited', exitCode: 0 }),
      terminal({ id: 'other', name: 'elsewhere', projectId: 'p2', status: 'exited', exitCode: 1 }),
    ]
    render(<TerminalSessionList />)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选已结束' }))
    expect(screen.getByRole('status')).toHaveTextContent('已选 2')
    fireEvent.click(screen.getByRole('button', { name: '全选 3' }))
    expect(screen.getByRole('status')).toHaveTextContent('已选 3')
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }))
    fireEvent.click(screen.getByRole('button', { name: '选已结束' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭所选' }))
    await vi.waitFor(() => expect(mocks.state.closeTerminal).toHaveBeenCalledTimes(2))
    expect(mocks.state.closeTerminal).toHaveBeenCalledWith('t2')
    expect(mocks.state.closeTerminal).toHaveBeenCalledWith('other')
    expect(mocks.state.closeTerminal).not.toHaveBeenCalledWith('t1')
  })

  it('closes a whole project from its own actions menu, not from the list header', async () => {
    mocks.state.terminals = [
      terminal({ status: 'exited', exitCode: 0 }),
      terminal({ id: 'other', name: 'elsewhere', projectId: 'p2', status: 'exited', exitCode: 0 }),
    ]
    render(<TerminalSessionList />)
    expect(screen.queryByRole('button', { name: '关闭当前项目的全部终端' })).toBeNull()
    fireEvent.click(within(group('p2')).getByRole('button', { name: '「api」的项目操作' }))
    fireEvent.click(screen.getByText('关闭此项目的全部终端'))
    await vi.waitFor(() => expect(mocks.state.closeAllProjectTerminals).toHaveBeenCalledWith('p2'))
    expect(mocks.state.closeAllProjectTerminals).toHaveBeenCalledTimes(1)
  })

  it('switches to another project from its actions menu', async () => {
    render(<TerminalSessionList />)
    fireEvent.click(within(group('p2')).getByRole('button', { name: '「api」的项目操作' }))
    fireEvent.click(screen.getByText('切换到此项目'))
    await vi.waitFor(() =>
      expect(mocks.projectState.switchProject).toHaveBeenCalledWith(mocks.projectState.projects[1]),
    )
  })

  const search = (value: string) =>
    fireEvent.change(screen.getByLabelText('搜索终端、项目或来源'), { target: { value } })
  const rowOrder = () =>
    [...document.querySelectorAll<HTMLElement>('[data-terminal-session-row]')].map(
      item => item.dataset.terminalSessionRow,
    )

  it('filters rows by the search box and clears with Escape', () => {
    render(<TerminalSessionList />)
    search('dev')
    expect(rowOrder()).toEqual(['t2'])
    fireEvent.keyDown(screen.getByLabelText('搜索终端、项目或来源'), { key: 'Escape' })
    expect(rowOrder()).toEqual(['t1', 't2', 'other'])
  })

  it('shows an empty state when nothing matches', () => {
    render(<TerminalSessionList />)
    search('nothing-here')
    expect(rowOrder()).toEqual([])
    expect(screen.getByText('没有匹配的终端')).toBeInTheDocument()
  })

  it('reveals matches inside collapsed groups without changing the saved collapse', () => {
    mocks.state.terminals = [terminal(), terminal({ id: 'other', name: 'hidden-one', projectId: 'p2' })]
    render(<TerminalSessionList />)
    fireEvent.click(screen.getByRole('button', { name: '展开或收起「api」' }))
    expect(row('other')).toBeNull()
    const saved = localStorage.getItem('qingcode:terminal-list-collapsed')
    search('hidden-one')
    expect(row('other')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开或收起「api」' }))
    expect(localStorage.getItem('qingcode:terminal-list-collapsed')).toBe(saved)
    search('')
    expect(row('other')).toBeNull()
  })

  it('toggles running-first ordering without saving it', () => {
    busyTerminals.add('t2')
    render(<TerminalSessionList />)
    expect(rowOrder()).toEqual(['t1', 't2', 'other'])
    const toggle = screen.getByRole('button', { name: '运行中优先' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(rowOrder()).toEqual(['t2', 't1', 'other'])
    fireEvent.click(toggle)
    expect(rowOrder()).toEqual(['t1', 't2', 'other'])
  })

  it('copies the path of the project the menu was opened from', () => {
    render(<TerminalSessionList />)
    fireEvent.click(within(group('p2')).getByRole('button', { name: '「api」的项目操作' }))
    fireEvent.click(screen.getByText('复制项目路径'))
    expect(copyPathAction).toHaveBeenCalledWith('/home/api')
  })

  it('does not offer switching to the current or an unavailable project', () => {
    mocks.projectState.unavailableProjectIds = ['p2']
    render(<TerminalSessionList />)
    fireEvent.click(within(group('p1')).getByRole('button', { name: '「app」的项目操作' }))
    expect(screen.getByText('当前项目').closest('button')).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(group('p2')).getByRole('button', { name: '「api」的项目操作' }))
    expect(screen.getByText('切换到此项目').closest('button')).toBeDisabled()
  })

  it('creates a terminal with the chosen profile in the project of the header', async () => {
    render(<TerminalSessionList />)
    mocks.projectState.switchProject.mockImplementation(async (project: { id: string; path: string; name: string }) => {
      mocks.projectState.currentProject = project
      return true
    })
    fireEvent.click(within(group('p3')).getByRole('button', { name: '为「docs」选择终端配置' }))
    fireEvent.click(screen.getByText(/普通终端/))
    await vi.waitFor(() =>
      expect(mocks.state.addTerminal).toHaveBeenCalledWith('/home/docs', 'p3', 'default'),
    )
  })

  it('leaves manage mode with 完成 or Escape and drops the selection', () => {
    render(<TerminalSessionList />)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    fireEvent.click(row('t2'))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(within(row('t1')).getByRole('button', { name: '关闭终端' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    expect(screen.getByRole('status')).toHaveTextContent('已选 0')
    fireEvent.keyDown(row('t1'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: '管理' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('selects a whole project from its tri-state checkbox and via the context menu entry', () => {
    render(<TerminalSessionList />)
    fireEvent.contextMenu(row('t2'))
    fireEvent.click(screen.getByText('批量操作'))
    expect(screen.getByRole('status')).toHaveTextContent('已选 1')
    expect(row('t2')).toHaveAttribute('aria-selected', 'true')
    const box = screen.getByRole('checkbox', { name: '选择「app」的全部终端' })
    expect(box).toHaveAttribute('aria-checked', 'mixed')
    fireEvent.click(box)
    expect(box).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('已选 2')
    fireEvent.click(box)
    expect(box).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('已选 0')
  })

  it('shows an empty state that points at the header action', () => {
    mocks.state.terminals = []
    render(<TerminalSessionList />)
    expect(screen.getByText('当前项目「app」暂无终端，点击上方 + 新建')).toBeInTheDocument()
  })
})
