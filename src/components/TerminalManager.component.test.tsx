// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    sshReady: vi.fn(async () => true),
    outputListeners: [] as Array<(event: { payload: unknown }) => void>,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.outputListeners.push(handler)
    return () => {
      mocks.outputListeners.splice(mocks.outputListeners.indexOf(handler), 1)
    }
  }),
}))

function store<T extends object>(state: T) {
  return Object.assign((selector: (value: T) => unknown) => selector(state), { getState: () => state })
}

vi.mock('../store/terminalStore', () => ({ useTerminalStore: store(mocks.terminalState) }))
vi.mock('../store/projectStore', () => ({ useProjectStore: store(mocks.projectState) }))
vi.mock('../store/uiStore', () => ({ useUIStore: store(mocks.uiState) }))
vi.mock('../store/confirmStore', () => ({ confirmDialog: mocks.confirm }))
vi.mock('../store/promptStore', () => ({ promptDialog: vi.fn() }))
vi.mock('../lib/sshWorkspace', () => ({
  isSshProject: (project: { path: string }) => project.path.startsWith('ssh://'),
  isSshWorkspaceReady: mocks.sshReady,
}))
vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  isSshResource: (value: unknown) => typeof value === 'string' && value.startsWith('ssh://'),
  safeInvoke: mocks.safeInvoke,
}))

import TerminalManager from './TerminalManager'

function tab(id: string, projectId: string, name: string): TerminalTab {
  return { id, name, projectId, cwd: 'C:\\a', launchCommand: '', status: 'running', exitCode: null } as TerminalTab
}

describe('TerminalManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirm.mockResolvedValue(true)
    mocks.sshReady.mockResolvedValue(true)
    mocks.projectState.projects = [
      { id: 'a', name: 'Alpha', path: 'C:\\a' },
      { id: 'b', name: 'Beta', path: 'C:\\b' },
    ]
    mocks.terminalState.terminals = [tab('t1', 'a', 'build'), tab('t2', 'b', 'server')]
    mocks.terminalState.closeTerminal.mockImplementation(async (id: string) => {
      mocks.terminalState.terminals = mocks.terminalState.terminals.filter(item => item.id !== id)
    })
    mocks.terminalState.findDetachedTerminals.mockResolvedValue(null)
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

  it('selects project rows on this page while select-all covers every page', async () => {
    mocks.safeInvoke.mockResolvedValue([])
    mocks.terminalState.terminals = Array.from({ length: 65 }, (_, index) => tab(`t${index}`, 'a', `terminal ${index}`))
    render(<TerminalManager />)
    expect(screen.getAllByRole('listitem')).toHaveLength(30)
    fireEvent.click(screen.getByLabelText('选择项目「Alpha」本页的终端'))
    expect(screen.getByText('已选 30 / 65')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('下一页'))
    expect(screen.getByText('terminal 30')).toBeTruthy()
    expect(screen.getByLabelText('选择项目「Alpha」本页的终端')).not.toBeChecked()
    expect(screen.getByText('已选 30 / 65')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('全选当前结果'))
    expect(screen.getByText('已选 65 / 65')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('下一页'))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getByLabelText('选择终端「terminal 64」')).toBeChecked()
    expect(screen.getByLabelText('下一页')).toBeDisabled()
  })

  it('clears selection when filtering and never closes hidden terminals', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    render(<TerminalManager />)
    await screen.findByText('claude')
    fireEvent.click(screen.getByLabelText('全选当前结果'))
    fireEvent.click(screen.getByRole('tab', { name: '手机 1' }))
    expect(screen.queryByText(/关闭所选/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭筛选结果' }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
    expect(mocks.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      title: '关闭筛选结果', message: '关闭 1 个终端？', detail: expect.stringContaining('不会关闭隐藏的终端'),
    }))
    expect(mocks.terminalState.closeTerminal).not.toHaveBeenCalled()
    expect(mocks.safeInvoke.mock.calls.filter(([, command]) => command === 'mobile_end_session')).toHaveLength(0)
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭筛选结果' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '关闭筛选结果' }))
    await waitFor(() => expect(mocks.safeInvoke).toHaveBeenCalledWith('结束手机终端', 'mobile_end_session', { id: 'mobile-1' }))
    expect(mocks.terminalState.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains failed desktop selections and retries only those failures', async () => {
    mocks.terminalState.closeTerminal.mockImplementationOnce(async () => undefined)
    render(<TerminalManager />)
    await screen.findByText('claude')
    fireEvent.click(screen.getByRole('tab', { name: '电脑 2' }))
    fireEvent.click(screen.getByLabelText('全选当前结果'))
    fireEvent.click(screen.getByRole('button', { name: '关闭所选 2' }))
    await waitFor(() => expect(mocks.projectState.pushToast).toHaveBeenCalledWith('warn', '已关闭 1 个终端，1 个失败', '关闭终端失败'))
    expect(screen.getByLabelText('选择终端「build」')).toBeChecked()
    expect(screen.queryByText('server')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '关闭所选 1' }))
    await waitFor(() => expect(mocks.projectState.pushToast).toHaveBeenCalledWith('success', '已关闭 1 个终端'))
    expect(mocks.terminalState.closeTerminal.mock.calls.map(([id]) => id)).toEqual(['t1', 't2', 't1'])
  })

  it('drops earlier refresh results instead of reviving closed mobile sessions', async () => {
    let finishStale!: (value: unknown[]) => void
    render(<TerminalManager />)
    await screen.findByText('claude')
    mocks.safeInvoke.mockImplementation(async (_label: string, command: string) => {
      if (command === 'mobile_sessions') return []
      return null
    })
    mocks.safeInvoke.mockImplementationOnce(() => new Promise(resolve => { finishStale = resolve }))
    fireEvent.click(screen.getByLabelText('刷新'))
    fireEvent.click(screen.getByLabelText('结束：claude'))
    await waitFor(() => expect(screen.queryByText('claude')).toBeNull())
    await act(async () => finishStale([{
      id: 'mobile-1', number: 1, name: 'claude', project: { id: 'b', name: 'Beta' },
    }]))
    expect(screen.queryByText('claude')).toBeNull()
  })

  it('ignores a slower overlapping refresh', async () => {
    let finishOld!: (value: unknown[]) => void
    mocks.safeInvoke.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    render(<TerminalManager />)
    await waitFor(() => expect(mocks.safeInvoke).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('刷新'))
    await screen.findByText('claude')
    await act(async () => finishOld([{
      id: 'mobile-old', number: 2, name: 'stale', project: { id: 'a', name: 'Alpha' },
    }]))
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.getByText('claude')).toBeTruthy()
  })

  it('keeps a failed mobile close selected and available to preview again', async () => {
    render(<TerminalManager />)
    await screen.findByText('claude')
    mocks.safeInvoke.mockImplementation(async (_label: string, command: string) => {
      if (command === 'mobile_end_session') throw new Error('phone offline')
      if (command === 'mobile_session_preview') return { name: 'claude', history: [], screen: 'preview output' }
      if (command === 'mobile_sessions') return [{
        id: 'mobile-1', number: 1, name: 'claude', project: { id: 'b', name: 'Beta' },
      }]
      return null
    })
    fireEvent.click(screen.getByLabelText('只读预览：claude'))
    await screen.findByText('preview output')
    fireEvent.click(within(screen.getByRole('dialog', { name: '只读预览 · claude' })).getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByLabelText('选择终端「claude」'))
    fireEvent.click(screen.getByRole('button', { name: '关闭所选 1' }))
    await waitFor(() => expect(mocks.projectState.pushToast).toHaveBeenCalledWith('warn', '已关闭 0 个终端，1 个失败', 'phone offline'))
    expect(screen.getByLabelText('选择终端「claude」')).toBeChecked()
    fireEvent.click(screen.getByLabelText('只读预览：claude'))
    expect(await screen.findByText('preview output')).toBeTruthy()
  })

  it('refreshes the preview dialog on output and returns to the same filtered selection on Escape', async () => {
    let output = 'first output'
    const original = mocks.safeInvoke.getMockImplementation()!
    mocks.safeInvoke.mockImplementation(async (label: string, command: string, args: unknown) => {
      if (command === 'mobile_session_preview') return {
        history: ['old shell history'], screen: output, alternate: true, rows: 30, cols: 42, truncated: true,
      }
      return original(label, command, args)
    })
    render(<TerminalManager />)
    await screen.findByText('claude')
    fireEvent.click(screen.getByRole('tab', { name: '手机 1' }))
    fireEvent.click(screen.getByLabelText('选择终端「claude」'))
    const eye = screen.getByLabelText('只读预览：claude')
    eye.focus()
    fireEvent.click(eye)
    await screen.findByText('first output')
    const dialog = screen.getByRole('dialog', { name: '只读预览 · claude' })
    expect(within(dialog).getByText(/Pixel · 42×30/)).toBeTruthy()
    expect(dialog).not.toHaveTextContent('old shell history')
    expect(dialog).not.toHaveTextContent('仅显示最近 200 行历史')
    expect(within(dialog).getByRole('button', { name: '关闭' })).toHaveFocus()
    await waitFor(() => expect(mocks.outputListeners).toHaveLength(1))

    output = 'other session'
    await act(async () => {
      mocks.outputListeners[0]({ payload: { id: 'mobile-other' } })
      await Promise.resolve()
    })
    expect(screen.queryByText('other session')).toBeNull()

    output = '表格\n\n  | 第二行 |'
    act(() => mocks.outputListeners[0]({ payload: { id: 'mobile-1' } }))
    await waitFor(() => expect(dialog.querySelector('pre')?.textContent).toBe(output))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(mocks.outputListeners).toHaveLength(0))
    await waitFor(() => expect(eye).toHaveFocus())
    expect(dialog).not.toBeInTheDocument()
    expect(screen.getByLabelText('选择终端「claude」')).toBeChecked()
    expect(screen.queryByText('build')).toBeNull()
    expect(mocks.uiState.closeTerminalManager).not.toHaveBeenCalled()
    expect(new Set(mocks.safeInvoke.mock.calls.map(call => call[1])))
      .toEqual(new Set(['mobile_sessions', 'mobile_session_preview']))
  })

  it('keeps ordinary history and the current screen selectable while output changes', async () => {
    let output = '  第一行\n\n最后一行'
    const original = mocks.safeInvoke.getMockImplementation()!
    mocks.safeInvoke.mockImplementation(async (label: string, command: string, args: unknown) =>
      command === 'mobile_session_preview'
        ? { history: ['早先的输出'], screen: output, alternate: false }
        : original(label, command, args))
    render(<TerminalManager />)
    fireEvent.click(await screen.findByLabelText('只读预览：claude'))
    const history = await screen.findByText('早先的输出')
    const pre = history.closest('pre')!
    expect(pre.textContent).toBe('早先的输出\n' + output)
    const selection = window.getSelection()!
    selection.selectAllChildren(history)
    output = '新输出'
    const notify = () => act(async () => { mocks.outputListeners[0]({ payload: { id: 'mobile-1' } }) })
    await notify()
    expect(pre.textContent).toContain('最后一行')
    expect(selection.toString()).toContain('早先的输出')
    selection.removeAllRanges()
    await notify()
    expect(pre.textContent).toBe('早先的输出\n新输出')
  })

  it('retains failed detached terminals and ends them without attaching', async () => {
    mocks.projectState.projects.push({ id: 'c', name: 'Remote', path: 'ssh://connection/srv/test' })
    mocks.terminalState.findDetachedTerminals.mockResolvedValue({
      connectionId: 'connection', terminals: [{ ptyId: 'pty-1', cwd: 'ssh://connection/srv/test', name: 'remote job' }],
    })
    render(<TerminalManager />)
    await screen.findByText('remote job')
    const original = mocks.safeInvoke.getMockImplementation()!
    mocks.safeInvoke.mockImplementation(async (label: string, command: string, args: unknown) => {
      if (command === 'ssh_kill_detached_terminal') throw new Error('remote unavailable')
      return original(label, command, args)
    })
    fireEvent.click(screen.getByRole('tab', { name: '远端未接回 1' }))
    fireEvent.click(screen.getByLabelText('全选当前结果'))
    fireEvent.click(screen.getByRole('button', { name: '关闭所选 1' }))
    await waitFor(() => expect(mocks.projectState.pushToast).toHaveBeenCalledWith('warn', '已关闭 0 个终端，1 个失败', 'remote unavailable'))
    expect(screen.getByLabelText('选择终端「remote job」')).toBeChecked()
    expect(mocks.terminalState.attachDetachedTerminals).not.toHaveBeenCalled()
    expect(mocks.safeInvoke).toHaveBeenCalledWith('结束远端终端', 'ssh_kill_detached_terminal', {
      ptyId: 'pty-1', cwd: 'ssh://connection/srv/test',
    })
  })

  it('shows the auto-end time to the minute for detached and phone terminals', async () => {
    mocks.projectState.projects.push({ id: 'c', name: 'Remote', path: 'ssh://connection/srv/test' })
    mocks.terminalState.findDetachedTerminals.mockResolvedValue({
      connectionId: 'connection',
      terminals: [
        { ptyId: 'pty-1', cwd: 'ssh://connection/srv/test', name: 'expiring', expiresAt: Date.now() + 3_600_000 },
        { ptyId: 'pty-2', cwd: 'ssh://connection/srv/test', name: 'old daemon' },
      ],
    })
    const original = mocks.safeInvoke.getMockImplementation()!
    mocks.safeInvoke.mockImplementation(async (label: string, command: string, args: unknown) => {
      const result = await original(label, command, args)
      return command === 'mobile_sessions'
        ? (result as object[]).map(item => ({ ...item, lastActiveAt: Date.now(), idleDeadline: Date.now() + 3_600_000 }))
        : result
    })
    render(<TerminalManager />)
    expect(await screen.findByText(/^未接回 · (\d{2}-\d{2} )?\d{2}:\d{2} 自动结束$/)).toBeTruthy()
    expect(screen.getByText('未接回 · 仍在远端运行')).toBeTruthy()
    expect(await screen.findByText(/\d{2}:\d{2} 自动结束 · 仅手机可操作$/)).toBeTruthy()
    // 电脑终端没有自动结束，只有上面两行显示。
    expect(screen.getAllByText(/自动结束/)).toHaveLength(2)
  })

  it('clears hidden selections when the search changes', async () => {
    render(<TerminalManager />)
    await screen.findByText('claude')
    fireEvent.click(screen.getByLabelText('选择终端「server」'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'build' } })
    expect(screen.queryByText('关闭所选 1')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(screen.getByLabelText('选择终端「server」')).not.toBeChecked()
  })

  it('does not connect to unavailable SSH projects to discover terminals', async () => {
    mocks.projectState.projects.push({ id: 'c', name: 'Remote', path: 'ssh://connection/srv/test' })
    mocks.sshReady.mockResolvedValue(false)
    render(<TerminalManager />)
    await waitFor(() => expect(mocks.sshReady).toHaveBeenCalledWith('ssh://connection/srv/test'))
    await screen.findByText('claude')
    expect(mocks.terminalState.findDetachedTerminals).not.toHaveBeenCalled()
  })

  it('does not kill a remote terminal reattached during confirmation', async () => {
    mocks.projectState.projects.push({ id: 'c', name: 'Remote', path: 'ssh://connection/srv/test' })
    mocks.terminalState.findDetachedTerminals.mockResolvedValue({
      connectionId: 'connection', terminals: [{ ptyId: 'pty-1', cwd: 'ssh://connection/srv/test', name: 'remote job' }],
    })
    let confirm!: (value: boolean) => void
    mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
    render(<TerminalManager />)
    await screen.findByText('remote job')
    fireEvent.click(screen.getByRole('tab', { name: '远端未接回 1' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭筛选结果' }))
    mocks.terminalState.terminals.push({ ...tab('reattached', 'c', 'remote job'), ptyId: 'pty-1', connectionId: 'connection' })
    await act(async () => confirm(true))
    await waitFor(() => expect(mocks.projectState.pushToast).toHaveBeenCalledWith(
      'warn', '已关闭 0 个终端，1 个失败', '远端终端已接回，请刷新列表后重试。',
    ))
    expect(mocks.safeInvoke.mock.calls.filter(([, command]) => command === 'ssh_kill_detached_terminal')).toHaveLength(0)
  })

  it('serializes same-frame destructive actions before React commits disabled controls', async () => {
    let confirm!: (value: boolean) => void
    mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
    render(<TerminalManager />)
    await screen.findByText('claude')
    const button = screen.getByRole('button', { name: '全部关闭' })
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox')).toBeDisabled()
    await act(async () => confirm(false))
    expect(mocks.terminalState.closeTerminal).not.toHaveBeenCalled()
  })

  it('uses the smoothed activity flag without altering a static program title', async () => {
    mocks.safeInvoke.mockResolvedValue([{
      id: 'mobile-1', number: 1, name: '✳ Claude Code', programTitle: '✳ Claude Code', programBusy: true,
      project: { id: 'b', name: 'Beta' },
    }])
    render(<TerminalManager />)
    await screen.findByText('✳ Claude Code')
    expect(screen.getByRole('img', { name: '程序正在工作' })).toHaveClass('motion-safe:animate-spin')
    expect(screen.getByText('✳ Claude Code')).toBeTruthy()
  })
})
