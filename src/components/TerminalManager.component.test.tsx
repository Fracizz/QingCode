// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '@/types'

const mocks = vi.hoisted(() => {
  const terminalState = {
    terminals: [] as TerminalTab[],
    setActiveTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    findDetachedTerminals: vi.fn(),
    attachDetachedTerminals: vi.fn(),
  }
  const projectState = {
    projects: [
      { id: 'a', name: 'Alpha', path: 'C:\\a' },
      { id: 'b', name: 'Beta', path: 'C:\\b' },
    ],
    currentProject: { id: 'a', name: 'Alpha', path: 'C:\\a' },
    switchProject: vi.fn(async () => true),
    pushToast: vi.fn(),
  }
  const uiState = { closeTerminalManager: vi.fn(), openTerminalPanel: vi.fn() }
  return {
    terminalState,
    projectState,
    uiState,
    safeInvoke: vi.fn(),
    confirm: vi.fn(async () => true),
  }
})

function store<T extends object>(state: T) {
  return Object.assign((selector: (value: T) => unknown) => selector(state), { getState: () => state })
}

vi.mock('../store/terminalStore', () => ({ useTerminalStore: store(mocks.terminalState) }))
vi.mock('../store/projectStore', () => ({ useProjectStore: store(mocks.projectState) }))
vi.mock('../store/uiStore', () => ({ useUIStore: store(mocks.uiState) }))
vi.mock('../store/confirmStore', () => ({ confirmDialog: mocks.confirm }))
vi.mock('../store/promptStore', () => ({ promptDialog: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  isSshResource: () => false,
  safeInvoke: mocks.safeInvoke,
}))

import TerminalManager from './TerminalManager'

function tab(id: string, projectId: string, name: string): TerminalTab {
  return { id, name, projectId, cwd: 'C:\\a', launchCommand: '', status: 'running', exitCode: null } as TerminalTab
}

describe('TerminalManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.terminalState.terminals = [tab('t1', 'a', 'build'), tab('t2', 'b', 'server')]
    mocks.safeInvoke.mockImplementation(async (_label: string, command: string) => {
      if (command === 'mobile_sessions') {
        return [
          {
            id: 'mobile-1',
            number: 1,
            name: 'claude',
            exit: null,
            lastActiveAt: 0,
            idleDeadline: null,
            project: { id: 'b', name: 'Beta', path: 'C:\\b', kind: 'local', host: 'Windows' },
            deviceName: 'Pixel',
          },
        ]
      }
      return null
    })
  })

  it('groups desktop and phone terminals by project and keeps phone terminals phone-only', async () => {
    render(<TerminalManager />)
    const beta = await screen.findByRole('region', { name: 'Beta' })
    await within(beta).findByText('claude')
    expect(within(screen.getByRole('region', { name: 'Alpha' })).getByText('build')).toBeTruthy()
    expect(within(beta).getByText('server')).toBeTruthy()
    expect(within(beta).getByText(/仅手机可操作/)).toBeTruthy()
    // 手机终端没有跳转或接回入口。
    expect(screen.queryByLabelText('跳转到终端：claude')).toBeNull()
    expect(screen.queryByLabelText('接回为终端标签：claude')).toBeNull()
    expect(screen.getByLabelText('跳转到终端：server')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '手机 1' }))
    expect(screen.queryByText('build')).toBeNull()
    expect(screen.getByText('claude')).toBeTruthy()
  })

  it('ends a phone session through the mobile command after confirmation', async () => {
    render(<TerminalManager />)
    fireEvent.click(await screen.findByLabelText('结束：claude'))
    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('结束手机终端', 'mobile_end_session', { id: 'mobile-1' }),
    )
    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.terminalState.closeTerminal).not.toHaveBeenCalled()
  })

  it('jumps to a desktop terminal in another project', async () => {
    render(<TerminalManager />)
    fireEvent.click(await screen.findByLabelText('跳转到终端：server'))
    await waitFor(() => expect(mocks.terminalState.setActiveTerminal).toHaveBeenCalledWith('t2'))
    expect(mocks.projectState.switchProject).toHaveBeenCalledWith(mocks.projectState.projects[1])
    expect(mocks.uiState.closeTerminalManager).toHaveBeenCalled()
  })
})
