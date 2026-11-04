// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '@/types'

const mocks = vi.hoisted(() => {
  const state = {
    terminals: [] as TerminalTab[],
    activeTerminalId: 't1',
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
    renameTerminal: vi.fn(),
    addTerminal: vi.fn(),
  }
  return { state, requestSettings: vi.fn() }
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
  useProjectStore: (
    selector: (state: {
      currentProject: { id: string; path: string }
      addEmptyProject: () => void
      switchProject: () => void
    }) => unknown,
  ) =>
    selector({
      currentProject: { id: 'p1', path: '/home/app' },
      addEmptyProject: vi.fn(),
      switchProject: vi.fn(),
    }),
}))

vi.mock('../store/uiStore', () => ({
  useUIStore: (
    selector: (state: {
      requestToggleTerminal: () => void
      panelLayout: 'bottomTerminal'
      requestSettings: (query: string) => void
    }) => unknown,
  ) =>
    selector({
      requestToggleTerminal: vi.fn(),
      panelLayout: 'bottomTerminal',
      requestSettings: mocks.requestSettings,
    }),
}))

vi.mock('../hooks/useInterfaceMetrics', () => ({
  useInterfaceMetrics: () => ({ fontSize: 12 }),
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
  default: ({
    label,
    children,
  }: {
    label: string
    children: React.ReactNode
  }) => <span data-tooltip={label}>{children}</span>,
}))

import TerminalTabs from './TerminalTabs'

function terminal(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 't1',
    name: 'Remote',
    projectId: 'p1',
    cwd: 'ssh://conn/home/app',
    launchCommand: '',
    status: 'running',
    exitCode: null,
    persistent: false,
    ...overrides,
  }
}

describe('TerminalTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('qingcode:terminal-profiles')
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  it('renders an in-app reconnecting Tooltip and no native title', () => {
    mocks.state.terminals = [
      terminal({ status: 'reconnecting', persistent: true, disconnectReason: 'keepalive timeout' }),
    ]
    render(<TerminalTabs />)

    expect(screen.getByRole('tab')).toBeInTheDocument()
    expect(screen.getByLabelText('正在重新连接…')).toBeInTheDocument()
    expect(
      document.querySelector('[data-tooltip="正在重新连接…"]'),
    ).toBeInTheDocument()
    expect(document.querySelector('[title]')).toBeNull()
  })

  it('warns when a non-persistent SSH process will end on disconnect', () => {
    mocks.state.terminals = [
      terminal({
        persistent: false,
        persistentFallbackReason: 'daemon unavailable',
      }),
    ]
    render(<TerminalTabs />)

    const tooltip = Array.from(document.querySelectorAll('[data-tooltip]')).find(element =>
      element.getAttribute('data-tooltip')?.includes('此终端断线会结束远端进程'),
    )
    expect(tooltip?.getAttribute('data-tooltip')).toContain(
      '未能持久化：daemon unavailable',
    )
  })

  it('creates a terminal from the visible profile menu', async () => {
    mocks.state.terminals = []
    localStorage.setItem('qingcode:terminal-profiles', JSON.stringify({
      profiles: [{ id: 'claude', name: 'Claude', shell: 'auto', command: 'claude' }],
    }))
    render(<TerminalTabs />)
    fireEvent.click(screen.getByRole('button', { name: '选择终端配置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    await waitFor(() => expect(mocks.state.addTerminal).toHaveBeenCalledWith('/home/app', 'p1', 'claude'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('keeps profile management available when the project reaches the terminal limit', () => {
    mocks.state.terminals = Array.from({ length: 10 }, (_, index) => terminal({ id: `t${index}` }))
    render(<TerminalTabs />)
    expect(screen.getByRole('button', { name: '新建终端' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '选择终端配置' }))
    expect(screen.getByRole('menuitem', { name: '普通终端（默认）' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: '管理终端配置' }))
    expect(mocks.requestSettings).toHaveBeenCalledWith('终端配置')
    expect(mocks.state.addTerminal).not.toHaveBeenCalled()
  })

})
