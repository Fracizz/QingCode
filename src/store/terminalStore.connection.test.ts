// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_RESET_EVENT } from '@/lib/terminal/terminalViewBridge'
import type { TerminalSpawnResult } from '@/lib/ipc/terminal'
import type { TerminalTab } from '@/types'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  attachTerminal: vi.fn(),
  createTerminal: vi.fn(),
  killTerminal: vi.fn(async () => undefined),
  listDetachedTerminals: vi.fn(),
  resizeTerminal: vi.fn(async () => undefined),
  spawnTerminalScript: vi.fn(),
  terminalSessionOpen: vi.fn(),
  writeTerminal: vi.fn(async () => undefined),
  choiceDialog: vi.fn(),
  pushToast: vi.fn(),
  serverModeErrorAction: vi.fn(),
  projectState: {
    projects: [] as Array<Record<string, unknown>>,
    currentProject: null as Record<string, unknown> | null,
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (name: string, callback: (event: { payload: unknown }) => void) => {
      const listeners = mocks.listeners.get(name) ?? new Set()
      listeners.add(callback)
      mocks.listeners.set(name, listeners)
      return () => {
        listeners.delete(callback)
      }
    },
  ),
}))

vi.mock('../lib/ipc/terminal', () => ({
  attachTerminal: (...args: unknown[]) => mocks.attachTerminal(...args),
  createTerminal: (...args: unknown[]) => mocks.createTerminal(...args),
  killTerminal: (...args: unknown[]) => mocks.killTerminal(...args),
  listDetachedTerminals: (...args: unknown[]) => mocks.listDetachedTerminals(...args),
  resizeTerminal: (...args: unknown[]) => mocks.resizeTerminal(...args),
  spawnTerminalScript: (...args: unknown[]) => mocks.spawnTerminalScript(...args),
  terminalSessionOpen: (...args: unknown[]) => mocks.terminalSessionOpen(...args),
  writeTerminal: (...args: unknown[]) => mocks.writeTerminal(...args),
}))

vi.mock('./projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      ...mocks.projectState,
      pushToast: mocks.pushToast,
    }),
  },
}))

vi.mock('./choiceStore', () => ({
  choiceDialog: (...args: unknown[]) => mocks.choiceDialog(...args),
}))

vi.mock('../lib/serverModeError', () => ({ serverModeErrorAction: mocks.serverModeErrorAction }))

vi.mock('./uiStore', () => ({
  useUIStore: {
    getState: () => ({
      openTerminalPanel: vi.fn(),
      setActiveTerminal: vi.fn(),
      toggleTerminalPanel: vi.fn(),
    }),
  },
}))

import { subscribeTerminalOutput, useTerminalStore } from './terminalStore'
import { activeTerminalsForConfig, findRunLinkageForTerminal } from '@/lib/runConfigRuntime'
import { buildWorkspaceSessionSnapshot, parseWorkspaceSession } from '@/lib/workspaceSessionPersist'
import { terminalFromPersisted } from '@/lib/workspaceSessionRestore'
import { planTerminalSpawn } from '@/lib/terminal/terminalSpawnPlan'
import { planTerminalRestore } from '@/lib/terminal/terminalRestorePlan'

function terminal(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 't1',
    name: 'SSH',
    projectId: 'p1',
    cwd: 'ssh://conn/home/app',
    launchCommand: '',
    status: 'running',
    exitCode: null,
    persistent: false,
    ...overrides,
  }
}

function emit(name: string, payload: unknown) {
  for (const listener of mocks.listeners.get(name) ?? []) {
    listener({ payload })
  }
}

describe('terminal persistent connection events', () => {
  let unlisten: (() => void) | undefined

  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.listeners.clear()
    mocks.attachTerminal.mockReset()
    mocks.createTerminal.mockReset()
    mocks.killTerminal.mockClear()
    mocks.writeTerminal.mockClear()
    mocks.spawnTerminalScript.mockReset()
    mocks.terminalSessionOpen.mockReset().mockResolvedValue(false)
    mocks.listDetachedTerminals.mockReset()
    mocks.choiceDialog.mockReset()
    mocks.pushToast.mockReset()
    mocks.serverModeErrorAction.mockReset()
    mocks.projectState.projects = []
    mocks.projectState.currentProject = null
    mocks.attachTerminal.mockResolvedValue({ persistent: true })
    mocks.createTerminal.mockResolvedValue({ persistent: false })
    mocks.listDetachedTerminals.mockResolvedValue([])
    useTerminalStore.setState({
      terminals: [terminal({ persistent: true })],
      activeTerminalId: 't1',
      activeTerminalByProject: { p1: 't1' },
    })
    unlisten = await useTerminalStore.getState().initializeTerminalEvents()
  })

  afterEach(() => {
    unlisten?.()
    vi.useRealTimers()
  })

  it('flows persistent reconnect events without spawning a replacement shell', () => {
    emit('terminal-connection', {
      id: 't1',
      state: 'reconnecting',
      attempt: 1,
      reason: 'keepalive timeout',
    })
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      status: 'reconnecting',
      disconnectReason: 'keepalive timeout',
      connectionAttempt: 1,
    })
    expect(mocks.createTerminal).not.toHaveBeenCalled()

    emit('terminal-connection', {
      id: 't1',
      state: 'attached',
      restore: 'snapshot',
    })
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      status: 'running',
      exitCode: null,
    })
    expect(mocks.createTerminal).not.toHaveBeenCalled()
  })

  it('stores the persistent capability returned by a new terminal spawn', async () => {
    mocks.createTerminal.mockResolvedValueOnce({ persistent: true })
    useTerminalStore.setState({
      terminals: [
        terminal({
          status: 'starting',
          persistent: undefined,
          ptySpawnPending: true,
        }),
      ],
    })

    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)

    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      status: 'running',
      persistent: true,
    })
  })

  it('binds a delayed spawn error to the original project root despite switching projects', async () => {
    const root = 'ssh://conn/home/app'
    const other = { id: 'p2', name: 'other', path: 'ssh://conn/home/other' }
    mocks.projectState.projects = [{ id: 'p1', name: 'original', path: root }, other]
    mocks.projectState.currentProject = mocks.projectState.projects[0]
    let rejectSpawn!: (error: Error) => void
    mocks.createTerminal.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSpawn = reject }))
    useTerminalStore.setState({
      terminals: [terminal({ cwd: `${root}/nested`, status: 'starting', ptySpawnPending: true })],
    })

    const spawning = useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    mocks.projectState.currentProject = other
    const error = new Error('Server 模式：daemon 未就绪')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      rejectSpawn(error)
      await spawning
      expect(mocks.serverModeErrorAction).toHaveBeenCalledWith(error, root)
    } finally {
      log.mockRestore()
    }
  })

  it('prefers attaching a restored daemon PTY and stores its fresh identity', async () => {
    mocks.attachTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-1',
      connectionId: 'conn',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          status: 'exited',
          persistent: true,
          ptyId: 'pty-1',
          connectionId: 'conn',
          awaitingRestoreSpawn: true,
          ptySpawnPending: true,
        }),
      ],
    })

    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)

    expect(mocks.attachTerminal).toHaveBeenCalledWith({
      id: 't1',
      ptyId: 'pty-1',
      cwd: 'ssh://conn/home/app',
      cols: 100,
      rows: 30,
    })
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      status: 'running',
      persistent: true,
      ptyId: 'pty-1',
      connectionId: 'conn',
      awaitingRestoreSpawn: false,
    })
  })

  it('does not kill the daemon PTY before the first restored attach', async () => {
    mocks.attachTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-restored',
      connectionId: 'conn',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          status: 'exited',
          persistent: true,
          ptyId: 'pty-restored',
          connectionId: 'conn',
          awaitingRestoreSpawn: true,
        }),
      ],
    })

    await useTerminalStore.getState().spawnRestoredTerminals('p1')

    expect(mocks.attachTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-restored' }),
    )
    expect(mocks.killTerminal).not.toHaveBeenCalled()
  })

  it('kills a restored daemon PTY when its tab closes before the first attach', async () => {
    mocks.attachTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-restored',
      connectionId: 'conn',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          id: 'restored-close',
          name: 'Restored',
          status: 'exited',
          persistent: true,
          ptyId: 'pty-restored',
          connectionId: 'conn',
          awaitingRestoreSpawn: true,
        }),
      ],
    })

    await useTerminalStore.getState().closeTerminal('restored-close')

    const temporaryId = mocks.attachTerminal.mock.calls[0][0].id
    expect(mocks.attachTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-restored', cwd: 'ssh://conn/home/app' }),
    )
    expect(mocks.killTerminal).toHaveBeenCalledWith(temporaryId)
    expect(useTerminalStore.getState().terminals).toHaveLength(0)
  })

  it('kills restored PTYs when closing every terminal in a project', async () => {
    mocks.attachTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-project',
      connectionId: 'conn',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          id: 'restored-project',
          status: 'exited',
          persistent: true,
          ptyId: 'pty-project',
          connectionId: 'conn',
          awaitingRestoreSpawn: true,
        }),
        terminal({ id: 'direct-project', status: 'running' }),
      ],
    })

    await useTerminalStore.getState().closeAllProjectTerminals('p1')

    const temporaryId = mocks.attachTerminal.mock.calls[0][0].id
    expect(mocks.killTerminal).toHaveBeenCalledWith(temporaryId)
    expect(mocks.killTerminal).toHaveBeenCalledWith('direct-project')
    expect(useTerminalStore.getState().terminals).toHaveLength(0)
  })

  it('kills a newly spawned PTY when the tab closes while creation is in flight', async () => {
    let resolveSpawn: ((value: TerminalSpawnResult) => void) | undefined
    mocks.createTerminal.mockReturnValueOnce(
      new Promise<TerminalSpawnResult>(resolve => {
        resolveSpawn = resolve
      }),
    )
    useTerminalStore.setState({
      terminals: [
        terminal({
          id: 'race-create',
          status: 'starting',
          persistent: undefined,
          ptySpawnPending: true,
        }),
      ],
    })

    const spawning = useTerminalStore.getState().spawnPendingTerminal('race-create', 100, 30)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    await useTerminalStore.getState().closeTerminal('race-create')
    resolveSpawn?.({ persistent: true, ptyId: 'pty-race', connectionId: 'conn' })
    await spawning

    expect(mocks.killTerminal).toHaveBeenCalledWith('race-create')
    expect(useTerminalStore.getState().terminals).toHaveLength(0)
  })

  it('falls back to a normal shell when restored PTY attach fails', async () => {
    mocks.attachTerminal.mockRejectedValueOnce(new Error('terminal not found'))
    mocks.createTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-new',
      connectionId: 'conn',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          status: 'exited',
          persistent: true,
          ptyId: 'pty-old',
          connectionId: 'conn',
          awaitingRestoreSpawn: true,
          ptySpawnPending: true,
        }),
      ],
    })

    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)

    expect(mocks.attachTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      status: 'running',
      persistent: true,
      ptyId: 'pty-new',
      connectionId: 'conn',
      awaitingRestoreSpawn: false,
    })
  })

  it('does not keep the stale PTY identity when the attach fallback is a direct terminal', async () => {
    mocks.attachTerminal.mockRejectedValueOnce(new Error('terminal not found'))
    mocks.createTerminal.mockResolvedValueOnce({
      persistent: false,
      ptyId: null,
      connectionId: 'conn',
      persistentFallbackReason: '远端 daemon 尚未就绪',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          status: 'exited',
          persistent: true,
          ptyId: 'pty-old',
          connectionId: 'conn',
          awaitingRestoreSpawn: true,
          ptySpawnPending: true,
        }),
      ],
    })

    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)

    const tab = useTerminalStore.getState().terminals[0]
    expect(tab.persistent).toBe(false)
    expect(tab.ptyId).toBeUndefined()
    expect(tab.persistentFallbackReason).toBe('远端 daemon 尚未就绪')
  })

  it('summarizes unowned detached terminals and reattaches them into tabs', async () => {
    const project = {
      id: 'p-orphan-attach',
      name: 'remote',
      path: 'ssh://conn-orphan/home/app',
      kind: 'ssh',
      connection_id: 'conn-orphan',
    }
    mocks.projectState.currentProject = project
    mocks.projectState.projects = [project]
    mocks.listDetachedTerminals.mockResolvedValueOnce([
      {
        ptyId: 'pty-owned',
        connectionId: 'conn-orphan',
        cwd: 'ssh://conn-orphan/home/app',
        cols: 100,
        rows: 30,
      },
      {
        ptyId: 'pty-orphan',
        connectionId: 'conn-orphan',
        cwd: 'ssh://conn-orphan/home/app',
        cols: 120,
        rows: 40,
        name: 'OpenCode',
      },
    ])
    mocks.choiceDialog.mockResolvedValueOnce('attach')
    mocks.attachTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-orphan',
      connectionId: 'conn-orphan',
    })
    useTerminalStore.setState({
      terminals: [
        terminal({
          projectId: project.id,
          cwd: project.path,
          persistent: true,
          connectionId: 'conn-orphan',
          ptyId: 'pty-owned',
        }),
      ],
    })

    await useTerminalStore.getState().syncDetachedTerminals(project.id)

    expect(mocks.pushToast).toHaveBeenCalledWith(
      'info',
      '远端还有 1 个终端在运行',
      undefined,
      expect.objectContaining({ label: '查看' }),
    )
    const action = mocks.pushToast.mock.calls[0][3] as {
      onAction: () => Promise<void>
    }
    await action.onAction()

    expect(mocks.choiceDialog).toHaveBeenCalledTimes(1)
    expect(mocks.attachTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        ptyId: 'pty-orphan',
        cwd: project.path,
        cols: 120,
        rows: 40,
      }),
    )
    expect(
      useTerminalStore.getState().terminals.filter(tab => tab.projectId === project.id),
    ).toHaveLength(2)
  })

  it('ends all detached terminals through attach/kill after confirmation', async () => {
    const project = {
      id: 'p-orphan-kill',
      name: 'remote',
      path: 'ssh://conn-kill/home/app',
      kind: 'ssh',
      connection_id: 'conn-kill',
    }
    mocks.projectState.currentProject = project
    mocks.projectState.projects = [project]
    mocks.listDetachedTerminals.mockResolvedValueOnce([
      {
        ptyId: 'pty-kill',
        connectionId: 'conn-kill',
        cwd: 'ssh://conn-kill/home/app',
        cols: 80,
        rows: 24,
      },
    ])
    mocks.choiceDialog.mockResolvedValueOnce('kill')
    mocks.attachTerminal.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-kill',
      connectionId: 'conn-kill',
    })
    useTerminalStore.setState({ terminals: [] })

    await useTerminalStore.getState().syncDetachedTerminals(project.id)
    const action = mocks.pushToast.mock.calls[0][3] as {
      onAction: () => Promise<void>
    }
    await action.onAction()

    expect(mocks.attachTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-kill', cwd: project.path }),
    )
    const tempId = mocks.attachTerminal.mock.calls[0][0].id
    expect(mocks.killTerminal).toHaveBeenCalledWith(tempId)
    expect(mocks.pushToast).toHaveBeenCalledWith('success', '已结束 1 个远端终端')
  })

  it('keeps the legacy bounded restart for a non-persistent SSH terminal', async () => {
    useTerminalStore.setState({ terminals: [terminal({ persistent: false })] })
    emit('terminal-exit', {
      id: 't1',
      exitCode: 0,
      disconnected: true,
      reason: 'remote closed',
    })
    expect(useTerminalStore.getState().terminals[0]?.status).toBe('starting')
    expect(mocks.createTerminal).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().terminals[0]?.status).toBe('running')
  })

  it('keeps terminal input enabled while a persistent connection reconnects', async () => {
    useTerminalStore.setState({
      terminals: [terminal({ status: 'reconnecting', persistent: true })],
    })

    await useTerminalStore.getState().writeToTerminal('t1', 'echo ok\r')

    expect(mocks.writeTerminal).toHaveBeenCalledWith('t1', 'echo ok\r')
  })

  function exitedTask(overrides: Partial<TerminalTab> = {}) {
    const tab = terminal({
      name: '前后端 · 后端',
      launchCommand: 'uvicorn app:main',
      shellKind: 'command',
      env: { TASK_ONLY: '1' },
      runConfigId: 'dev',
      runTaskId: 'backend',
      pane: 'secondary',
      status: 'exited',
      exitCode: 1,
      ...overrides,
    })
    mocks.projectState.projects = [{ id: 'p1', path: tab.cwd, ephemeral: true }]
    useTerminalStore.setState({ terminals: [tab] })
    return tab
  }

  it.each([
    ['local', '/tmp/project', false],
    ['SSH direct', 'ssh://conn/home/app', false],
    ['SSH daemon', 'ssh://conn/home/app', true],
  ])('opens a plain shell after a finished %s task and restores it without rerunning the task', async (_mode, cwd, persistent) => {
    const task = exitedTask({ cwd, persistent, ptyId: persistent ? 'old-task-pty' : undefined })
    mocks.createTerminal.mockResolvedValue({ persistent, ptyId: persistent ? 'shell-pty' : undefined })
    emit('terminal-data', { id: task.id, data: Array.from(new TextEncoder().encode('Address already in use\r\n')) })
    await useTerminalStore.getState().resizeTerminal(task.id, 110, 35)

    await useTerminalStore.getState().writeToTerminal(task.id, '\x03')
    await vi.advanceTimersByTimeAsync(0)

    const shell = useTerminalStore.getState().terminals[0]
    expect(mocks.createTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: task.id, cwd, cols: 110, rows: 35,
    }))
    expect(mocks.spawnTerminalScript).not.toHaveBeenCalled()
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
    expect(mocks.writeTerminal).not.toHaveBeenCalled()
    expect(shell).toMatchObject({
      id: task.id, name: '前后端 · 后端 · 命令行', cwd, pane: 'secondary',
      status: 'running', launchCommand: '',
    })
    expect(shell.env).toBeUndefined()
    expect(shell.runConfigId).toBeUndefined()
    expect(activeTerminalsForConfig('dev', [shell])).toEqual([])
    expect(findRunLinkageForTerminal(shell, [{
      id: 'dev', name: '前后端', tasks: [{ id: 'backend', name: '后端', type: 'command', target: task.launchCommand }],
    }])).toBeNull()
    const replay: Uint8Array[] = []
    subscribeTerminalOutput(task.id, data => replay.push(data))()
    expect(replay.map(data => new TextDecoder().decode(data)).join('')).toContain('Address already in use')

    const snapshot = buildWorkspaceSessionSnapshot({
      editorSessions: {}, terminals: [shell], activeTerminalByProject: { p1: task.id },
    })
    const parsed = parseWorkspaceSession(JSON.parse(JSON.stringify(snapshot)))!
    const restored = terminalFromPersisted('p1', parsed.projects.p1.terminals[0])
    expect(planTerminalSpawn(restored)).toEqual({ mode: 'shell' })
    expect(restored.runConfigId).toBeUndefined()
    expect(planTerminalRestore(restored).mode).toBe(persistent ? 'attach' : 'create')
    if (persistent) expect(restored.ptyId).toBe('shell-pty')

    await useTerminalStore.getState().writeToTerminal(task.id, 'echo ready\r')
    expect(mocks.writeTerminal).toHaveBeenCalledWith(task.id, 'echo ready\r')
  })

  it('coalesces repeated Ctrl+C while checking the finished session', async () => {
    exitedTask()
    let resolveSession!: (open: boolean) => void
    mocks.terminalSessionOpen.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveSession = resolve }))
    const first = useTerminalStore.getState().writeToTerminal('t1', '\x03')
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    resolveSession(false)
    await first
    await vi.advanceTimersByTimeAsync(2500)
    expect(mocks.terminalSessionOpen).toHaveBeenCalledTimes(1)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not replace a live task behind a stale exited view', async () => {
    const task = exitedTask()
    mocks.terminalSessionOpen.mockResolvedValueOnce(true)
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    expect(useTerminalStore.getState().terminals[0]).toEqual({ ...task, status: 'running', exitCode: null })
    expect(mocks.killTerminal).not.toHaveBeenCalled()
    expect(mocks.createTerminal).not.toHaveBeenCalled()
  })

  it('does not reopen a tab closed during the session check', async () => {
    exitedTask()
    let resolveSession!: (open: boolean) => void
    mocks.terminalSessionOpen.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveSession = resolve }))
    const entering = useTerminalStore.getState().writeToTerminal('t1', '\x03')
    await useTerminalStore.getState().closeTerminal('t1')
    resolveSession(false)
    await entering
    await vi.advanceTimersByTimeAsync(2500)
    expect(useTerminalStore.getState().terminals).toEqual([])
    expect(mocks.createTerminal).not.toHaveBeenCalled()
  })

  it('checks current workspace trust before converting a task', async () => {
    const task = exitedTask()
    mocks.projectState.projects = [{ id: 'p1', path: task.cwd }]
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    expect(useTerminalStore.getState().terminals[0]).toEqual(task)
    expect(mocks.killTerminal).not.toHaveBeenCalled()
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('info', '当前为受限模式，无法打开终端')
  })

  it('keeps the failed task intact if the session check fails and allows retry', async () => {
    const task = exitedTask()
    mocks.terminalSessionOpen.mockRejectedValueOnce(new Error('connection failed'))
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    expect(useTerminalStore.getState().terminals[0]).toEqual(task)
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    await vi.advanceTimersByTimeAsync(2500)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
  })

  it.each([
    { awaitingRestoreSpawn: true },
    { ptySpawnPending: true },
    { shellKind: undefined },
  ] as Partial<TerminalTab>[])('ignores Ctrl+C on pending restore/spawn and plain exited shells: %j', async overrides => {
    exitedTask(overrides)
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    expect(mocks.terminalSessionOpen).not.toHaveBeenCalled()
    expect(mocks.createTerminal).not.toHaveBeenCalled()
  })

  it('ignores ordinary input after exit and still sends Ctrl+C to running tasks', async () => {
    exitedTask()
    await useTerminalStore.getState().writeToTerminal('t1', 'echo ignored\r')
    expect(mocks.writeTerminal).not.toHaveBeenCalled()
    expect(mocks.terminalSessionOpen).not.toHaveBeenCalled()
    useTerminalStore.setState({ terminals: [terminal({ shellKind: 'command' })] })
    await useTerminalStore.getState().writeToTerminal('t1', '\x03')
    expect(mocks.writeTerminal).toHaveBeenCalledWith('t1', '\x03')
  })

  it('keeps explicit restart on an unconverted task running its original command', async () => {
    exitedTask()
    await useTerminalStore.getState().restartTerminal('t1')
    await vi.advanceTimersByTimeAsync(2500)
    expect(mocks.spawnTerminalScript).toHaveBeenCalledWith(expect.objectContaining({
      shellKind: 'command', target: 'uvicorn app:main', env: { TASK_ONLY: '1' },
    }))
    expect(mocks.createTerminal).not.toHaveBeenCalled()
  })

  it('asks the mounted xterm view to reset on terminal-reset', () => {
    const resets: string[] = []
    const onReset = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string }>).detail
      if (detail.terminalId) resets.push(detail.terminalId)
    }
    window.addEventListener(TERMINAL_RESET_EVENT, onReset)

    emit('terminal-reset', { id: 't1' })

    expect(resets).toEqual(['t1'])
    window.removeEventListener(TERMINAL_RESET_EVENT, onReset)
  })
})
