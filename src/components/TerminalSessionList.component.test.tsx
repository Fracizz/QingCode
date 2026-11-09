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
  return { state, ui, project: { id: 'p1', path: '/home/app', name: 'app' } as { id: string; path: string; name: string } | null }
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
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ currentProject: mocks.project, addEmptyProject: vi.fn(), switchProject: vi.fn() }),
}))

vi.mock('../store/uiStore', () => ({
  useUIStore: (selector: (state: typeof mocks.ui) => unknown) => selector(mocks.ui),
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

describe('TerminalSessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.project = { id: 'p1', path: '/home/app', name: 'app' }
    mocks.state.activeTerminalId = 't1'
    mocks.state.terminals = [
      terminal(),
      terminal({ id: 't2', name: 'dev', launchCommand: 'pnpm dev', pane: 'secondary' }),
      terminal({ id: 'other', name: 'elsewhere', projectId: 'p2' }),
    ]
  })

  it('lists every terminal of the current project regardless of its pane', () => {
    render(<TerminalSessionList />)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.queryByText('elsewhere')).not.toBeInTheDocument()
    expect(row('t1')).toHaveAttribute('aria-selected', 'true')
    expect(within(row('t2')).getByText('pnpm dev')).toBeInTheDocument()
    expect(document.querySelector('[title]')).toBeNull()
  })

  it('selects a terminal and reopens a collapsed terminal panel', () => {
    render(<TerminalSessionList />)
    fireEvent.click(row('t2'))
    expect(mocks.state.setActiveTerminal).toHaveBeenCalledWith('t2')
    expect(mocks.ui.openTerminalPanel).toHaveBeenCalledTimes(1)
  })

  it('moves the selection with the arrow keys and wraps around', () => {
    render(<TerminalSessionList />)
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(mocks.state.setActiveTerminal).toHaveBeenLastCalledWith('t2')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(mocks.state.setActiveTerminal).toHaveBeenLastCalledWith('t2')
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
    expect(screen.getByRole('button', { name: '关闭全部终端' })).toBeDisabled()
  })
})
