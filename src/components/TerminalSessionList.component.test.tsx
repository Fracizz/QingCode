// @vitest-environment jsdom

import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    addEmptyProject: vi.fn(),
    switchProject: vi.fn(),
    pushToast: vi.fn(),
  }
  return { state, ui, projectState }
})

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

describe('TerminalSessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    pruneTerminalAttention(new Set())
    mocks.projectState.currentProject = mocks.projectState.projects[0]
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
    expect(within(row('t2')).getByText('pnpm dev')).toBeInTheDocument()
    expect(document.querySelector('[title]')).toBeNull()
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
    expect(within(group('p3')).getByRole('button', { name: '展开或收起「docs」' })).toBeDisabled()
  })

  it('does not activate a terminal of another project when arming its close button', () => {
    render(<TerminalSessionList />)
    fireEvent.click(within(row('other')).getByRole('button', { name: '关闭终端' }))
    expect(mocks.state.setActiveTerminal).not.toHaveBeenCalled()
    expect(within(row('other')).getByRole('button', { name: '确认关闭终端' })).toBeInTheDocument()
  })

  it('does not reorder onto a terminal of another project', () => {
    render(<TerminalSessionList />)
    const dataTransfer = { setData: vi.fn(), getData: () => 't1', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(row('t1'), { dataTransfer })
    fireEvent.drop(row('other'), { dataTransfer })
    expect(mocks.state.reorderTerminal).not.toHaveBeenCalled()
  })

  it('shows a waiting state instead of restart for terminals not restored yet', () => {
    mocks.state.terminals = [terminal({ id: 'other', projectId: 'p2', status: 'exited', awaitingRestoreSpawn: true })]
    render(<TerminalSessionList />)
    expect(within(row('other')).getByText('切换到项目后恢复')).toBeInTheDocument()
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
    const target = row('t1')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40, left: 0, width: 200 } as DOMRect)
    const dataTransfer = { setData: vi.fn(), getData: () => 't2', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(row('t2'), { dataTransfer })
    // jsdom 的拖放事件不带坐标，手动补上；同一横坐标下只有纵坐标决定落点。
    const dropAt = (clientY: number) => {
      const event = createEvent.drop(target, { dataTransfer })
      Object.defineProperties(event, {
        clientX: { value: 500 },
        clientY: { value: clientY },
      })
      fireEvent(target, event)
    }
    dropAt(110)
    expect(mocks.state.reorderTerminal).toHaveBeenLastCalledWith('t2', 't1', 'before')
    dropAt(130)
    expect(mocks.state.reorderTerminal).toHaveBeenLastCalledWith('t2', 't1', 'after')
  })

  it('offers restart for an exited terminal', () => {
    mocks.state.terminals = [terminal({ status: 'exited', exitCode: 2 })]
    render(<TerminalSessionList />)
    expect(within(row('t1')).getByText('已退出（退出码 2）')).toBeInTheDocument()
    expect(within(row('t1')).getByRole('button', { name: /重启/ })).toBeInTheDocument()
  })

  it('shows an empty state that points at the header action', () => {
    mocks.state.terminals = []
    render(<TerminalSessionList />)
    expect(screen.getByText('当前项目「app」暂无终端，点击上方 + 新建')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭当前项目的全部终端' })).toBeDisabled()
  })
})
