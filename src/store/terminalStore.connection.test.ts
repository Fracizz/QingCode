// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSpawnResult } from '@/lib/ipc/terminal'
import type { TerminalTab } from '@/types'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  attachTerminal: vi.fn(),
  createTerminal: vi.fn(),
  killDetachedTerminal: vi.fn(async () => undefined),
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
  killDetachedTerminal: (...args: unknown[]) => mocks.killDetachedTerminal(...args),
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

import { pauseTerminalSpawnsForExit, resumeTerminalSpawnsAfterExit, setTerminalViewGrid, subscribeTerminalOutput, useTerminalStore } from './terminalStore'
import { activeTerminalsForConfig, findRunLinkageForTerminal } from '@/lib/runConfigRuntime'
import { buildWorkspaceSessionSnapshot, parseWorkspaceSession } from '@/lib/workspaceSessionPersist'
import { terminalFromPersisted } from '@/lib/workspaceSessionRestore'
import { planTerminalSpawn } from '@/lib/terminal/terminalSpawnPlan'
import { planTerminalRestore } from '@/lib/terminal/terminalRestorePlan'
import { hasLocalHostedSession } from '@/lib/appCloseFlow'

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

const remotePlatformPaths = ['ssh://conn/home/app', 'ssh://conn/D:/app', 'ssh://conn/Users/dev/app']

describe('terminal persistent connection events', () => {
  let unlisten: (() => void) | undefined

  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.listeners.clear()
    mocks.attachTerminal.mockReset()
    mocks.createTerminal.mockReset()
    mocks.killDetachedTerminal.mockReset().mockResolvedValue(undefined)
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
    useTerminalStore.setState({ terminals: [] })
    resumeTerminalSpawnsAfterExit()
    vi.useRealTimers()
  })

  it('freezes pending PTYs during an exit decision and resumes after cancellation', async () => {
    useTerminalStore.setState({ terminals: [terminal({ status: 'starting', ptySpawnPending: true })] })
    await pauseTerminalSpawnsForExit()
    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(await useTerminalStore.getState().addTerminal('ssh://conn/home/app', 'p1')).toBeNull()
    resumeTerminalSpawnsAfterExit()
    await vi.advanceTimersByTimeAsync(2500)
    expect(mocks.createTerminal).toHaveBeenCalledOnce()
  })

  it('settles in-flight creation before reading the persistent PTY for exit', async () => {
    let complete!: (result: TerminalSpawnResult) => void
    mocks.createTerminal.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    useTerminalStore.setState({ terminals: [terminal({ status: 'starting', ptySpawnPending: true })] })
    const spawning = useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    let settled = false
    const pausing = pauseTerminalSpawnsForExit().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(25)
    expect(settled).toBe(false)
    complete({ persistent: true, ptyId: 'created-during-exit', connectionId: 'conn' })
    await spawning
    await vi.advanceTimersByTimeAsync(25)
    await pausing
    expect(useTerminalStore.getState().terminals[0].ptyId).toBe('created-during-exit')
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

  it('hosts Windows shells by default and restores the same PTY after persistence', async () => {
    const hosted = { persistent: true, ptyId: 'local-pty', connectionId: '__local__' }
    mocks.createTerminal.mockResolvedValueOnce(hosted)
    useTerminalStore.setState({ terminals: [terminal({
      cwd: 'C:\\work', status: 'starting', persistent: undefined, ptySpawnPending: true,
    })] })
    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ persistLocal: true }))
    const live = useTerminalStore.getState().terminals[0]
    expect(hasLocalHostedSession(live)).toBe(true)

    const snapshot = buildWorkspaceSessionSnapshot({
      editorSessions: {}, terminals: [live], activeTerminalByProject: { p1: live.id },
    })
    const parsed = parseWorkspaceSession(JSON.parse(JSON.stringify(snapshot)))!
    const restored = terminalFromPersisted('p1', parsed.projects.p1.terminals[0])
    mocks.attachTerminal.mockResolvedValueOnce(hosted)
    useTerminalStore.setState({ terminals: [restored] })
    await useTerminalStore.getState().spawnRestoredTerminals('p1')
    expect(mocks.attachTerminal).toHaveBeenCalledWith(expect.objectContaining({
      id: live.id, cwd: 'C:\\work', ptyId: 'local-pty',
    }))
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ ...hosted, status: 'running' })
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
      expect(mocks.serverModeErrorAction).toHaveBeenCalledWith(error, root, undefined, expect.any(Function))
    } finally {
      log.mockRestore()
    }
  })

  it('retries a failed spawn only while the terminal is still exited', async () => {
    mocks.createTerminal.mockRejectedValueOnce(new Error('Server 模式：[direct:unreachable] 无法连接'))
    useTerminalStore.setState({
      terminals: [terminal({ status: 'starting', ptySpawnPending: true })],
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const originalRestart = useTerminalStore.getState().restartTerminal
    const restartTerminal = vi.fn().mockResolvedValue(undefined)
    try {
      await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
      const retry = mocks.serverModeErrorAction.mock.calls[0][3] as () => void
      useTerminalStore.setState({ restartTerminal })

      retry()
      expect(restartTerminal).toHaveBeenCalledExactlyOnceWith('t1', { preserveOutput: true })

      restartTerminal.mockClear()
      useTerminalStore.setState({ terminals: [terminal({ status: 'running' })] })
      retry()
      expect(restartTerminal).not.toHaveBeenCalled()
    } finally {
      useTerminalStore.setState({ restartTerminal: originalRestart })
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

    // 视图还没量出网格：沿用 PTY 现有尺寸接回，不拿调用方猜的尺寸去改正在运行的进程。
    expect(mocks.attachTerminal).toHaveBeenCalledWith({
      id: 't1',
      ptyId: 'pty-1',
      cwd: 'ssh://conn/home/app',
      cols: null,
      rows: null,
      fromSeq: null,
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

  it('replays resize and redraw requested while a restored attach is in flight', async () => {
    let complete!: (result: TerminalSpawnResult) => void
    mocks.attachTerminal.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    mocks.resizeTerminal.mockClear()
    const restoring = terminal({
      status: 'exited',
      persistent: true,
      ptyId: 'pty-1',
      connectionId: 'conn',
      awaitingRestoreSpawn: true,
      ptySpawnPending: true,
    })
    useTerminalStore.setState({ terminals: [restoring] })
    setTerminalViewGrid('t1', { cols: 100, rows: 30 })
    const spawning = useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    // 后端尚未登记终端：重绘与 resize 都不能下发，否则失败后被去重吞掉。
    expect(await useTerminalStore.getState().redrawTerminal('t1', 100, 30)).toBe(false)
    expect(mocks.resizeTerminal).not.toHaveBeenCalled()
    complete({ persistent: true, ptyId: 'pty-1', connectionId: 'conn' })
    await spawning
    // 重绘两步与接回前的对齐之间都要隔开 300ms：紧挨着改尺寸时 ConPTY 下的 TUI
    // 来不及响应中间尺寸，画面会被永久裁坏（OpenCode 实测）。
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.resizeTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.resizeTerminal.mock.calls).toEqual([['t1', 100, 29]])
    await vi.advanceTimersByTimeAsync(299)
    expect(mocks.resizeTerminal.mock.calls).toEqual([['t1', 100, 29]])
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.resizeTerminal.mock.calls).toEqual([
      ['t1', 100, 29],
      ['t1', 100, 30],
    ])

    // 在途期间网格变了：补一次真实 resize（ConPTY 会随之整屏重绘），不再额外重绘。
    mocks.resizeTerminal.mockClear()
    mocks.attachTerminal.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    useTerminalStore.setState({ terminals: [restoring] })
    const again = useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    await useTerminalStore.getState().redrawTerminal('t1', 100, 30)
    await useTerminalStore.getState().resizeTerminal('t1', 120, 40)
    expect(mocks.resizeTerminal).not.toHaveBeenCalled()
    complete({ persistent: true, ptyId: 'pty-1', connectionId: 'conn' })
    await again
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.resizeTerminal.mock.calls).toEqual([['t1', 120, 40]])

    // 沿用 PTY 尺寸接回时本端不知道 PTY 尺寸：在途期间量出的网格接回后一定下发。
    setTerminalViewGrid('t1', null)
    mocks.resizeTerminal.mockClear()
    mocks.attachTerminal.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    useTerminalStore.setState({ terminals: [restoring] })
    const unsized = useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    await useTerminalStore.getState().resizeTerminal('t1', 100, 30)
    complete({ persistent: true, ptyId: 'pty-1', connectionId: 'conn' })
    await unsized
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.resizeTerminal.mock.calls).toEqual([['t1', 100, 30]])
  })

  it('spaces PTY size changes and keeps only the latest size queued inside the gap', async () => {
    mocks.resizeTerminal.mockClear()
    useTerminalStore.setState({ terminals: [terminal({ id: 'pace', status: 'running' })] })
    const store = useTerminalStore.getState()
    await store.resizeTerminal('pace', 100, 30)
    expect(mocks.resizeTerminal.mock.calls).toEqual([['pace', 100, 30]])
    // 间隔内的中间尺寸若真下发，ConPTY 会按它裁掉缓冲区而 TUI 来不及重画：只发最新的。
    const first = store.resizeTerminal('pace', 80, 24)
    const second = store.resizeTerminal('pace', 120, 40)
    await vi.advanceTimersByTimeAsync(299)
    expect(mocks.resizeTerminal.mock.calls).toEqual([['pace', 100, 30]])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(mocks.resizeTerminal.mock.calls).toEqual([
      ['pace', 100, 30],
      ['pace', 120, 40],
    ])
  })

  it('resumes a restored daemon PTY from the last output sequence it received', async () => {
    const restoring = terminal({
      id: 'resume',
      status: 'exited',
      persistent: true,
      ptyId: 'pty-r',
      connectionId: 'conn',
      awaitingRestoreSpawn: true,
      ptySpawnPending: true,
    })
    useTerminalStore.setState({ terminals: [restoring] })
    emit('terminal-data', { id: 'resume', data: Array.from(new TextEncoder().encode('a')), nextSeq: 41 })
    emit('terminal-screen', { id: 'resume', data: 'S', cols: 80, rows: 24, nextSeq: 42 })

    await useTerminalStore.getState().spawnPendingTerminal('resume', 100, 30)

    expect(mocks.attachTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resume', ptyId: 'pty-r', fromSeq: 42 })
    )
  })

  it.each(remotePlatformPaths)(
    'restores a run task without killing or rerunning its command at %s',
    async cwd => {
      mocks.attachTerminal.mockResolvedValueOnce({
        persistent: true,
        ptyId: 'pty-restored',
        connectionId: 'conn',
      })
      useTerminalStore.setState({
        terminals: [
          terminal({
            status: 'exited',
            cwd,
            shellKind: 'command',
            launchCommand: 'python manage.py runserver',
            runConfigId: 'dev',
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
      expect(mocks.createTerminal).not.toHaveBeenCalled()
      expect(mocks.spawnTerminalScript).not.toHaveBeenCalled()
      expect(useTerminalStore.getState().terminals[0]).toMatchObject({
        status: 'running',
        ptyId: 'pty-restored',
        runConfigId: 'dev',
        awaitingRestoreSpawn: false,
      })
    }
  )

  it('attaches a restored PTY with the mounted view grid instead of the 80x24 default', async () => {
    mocks.attachTerminal.mockResolvedValue({ persistent: true, ptyId: 'pty-restored', connectionId: 'conn' })
    const restored = terminal({
      status: 'exited',
      persistent: true,
      ptyId: 'pty-restored',
      connectionId: 'conn',
      awaitingRestoreSpawn: true,
    })
    // 重启后 lastPtySize 为空：已挂载视图的网格优先，快照与 TUI 重绘才会与视图同一网格。
    setTerminalViewGrid('t1', { cols: 183, rows: 52 })
    useTerminalStore.setState({ terminals: [restored] })
    await useTerminalStore.getState().spawnRestoredTerminals('p1')
    expect(mocks.attachTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ ptyId: 'pty-restored', cols: 183, rows: 52 }),
    )

    // 没有可用网格时不传尺寸：默认 80x24 会把运行中的 TUI 先缩小再撑回，ConPTY 截掉的
    // 内容不会被重画。视图之后量出的网格照常下发，不被猜测尺寸的去重吞掉。
    setTerminalViewGrid('t1', null)
    mocks.resizeTerminal.mockClear()
    useTerminalStore.setState({ terminals: [{ ...restored, id: 't2' }] })
    await useTerminalStore.getState().spawnRestoredTerminals('p1')
    expect(mocks.attachTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 't2', cols: null, rows: null }),
    )
    const resizing = useTerminalStore.getState().resizeTerminal('t2', 80, 24)
    await vi.advanceTimersByTimeAsync(300)
    await resizing
    expect(mocks.resizeTerminal).toHaveBeenCalledWith('t2', 80, 24)
  })

  it('kills a restored daemon PTY when its tab closes before the first attach', async () => {
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

    expect(mocks.killDetachedTerminal).toHaveBeenCalledWith({
      ptyId: 'pty-restored', cwd: 'ssh://conn/home/app',
    })
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals).toHaveLength(0)
  })

  it('kills restored PTYs when closing every terminal in a project', async () => {
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

    expect(mocks.killDetachedTerminal).toHaveBeenCalledWith({
      ptyId: 'pty-project', cwd: 'ssh://conn/home/app',
    })
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
    expect(mocks.killTerminal).toHaveBeenCalledWith('direct-project', 'user_close_all', expect.any(String))
    expect(useTerminalStore.getState().terminals).toHaveLength(0)
  })

  it('keeps a restored tab available for retry when the direct stop fails', async () => {
    mocks.killDetachedTerminal.mockRejectedValueOnce(new Error('offline'))
    useTerminalStore.setState({ terminals: [terminal({
      id: 'retry-close', persistent: true, ptyId: 'pty-offline', awaitingRestoreSpawn: true,
    })] })

    await useTerminalStore.getState().closeTerminal('retry-close')

    expect(useTerminalStore.getState().terminals).toHaveLength(1)
    expect(mocks.pushToast).toHaveBeenCalledWith('error', '关闭终端失败: Error: offline')
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
    await useTerminalStore.getState().closeTerminal('retry-close')
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

    expect(mocks.killTerminal).toHaveBeenCalledWith('race-create', 'spawn_cancelled')
    expect(useTerminalStore.getState().terminals).toHaveLength(0)
  })

  it.each(remotePlatformPaths)('preserves a missing restored PTY without rerunning its task at %s', async cwd => {
    mocks.attachTerminal.mockRejectedValueOnce(new Error('QC_PTY_GONE: PTY 不存在或已退出'))
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
          cwd,
          shellKind: 'command',
          launchCommand: 'python manage.py runserver',
          awaitingRestoreSpawn: true,
          ptySpawnPending: true,
        }),
      ],
    })

    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)

    expect(mocks.attachTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(mocks.spawnTerminalScript).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      status: 'exited', persistent: true, ptyId: 'pty-old', connectionId: 'conn',
      awaitingRestoreSpawn: false, ptySpawnPending: false,
    })
  })

  it('opens an ordinary shell only after an explicit action following failed restore', async () => {
    mocks.attachTerminal.mockRejectedValueOnce(new Error('QC_PTY_GONE: PTY 不存在或已退出'))
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

    expect(mocks.createTerminal).not.toHaveBeenCalled()
    await useTerminalStore.getState().reopenTerminalShell('t1')
    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    const tab = useTerminalStore.getState().terminals[0]
    expect(tab.persistent).toBe(false)
    expect(tab.ptyId).toBeUndefined()
    expect(tab.launchCommand).toBe('')
    expect(tab.persistentFallbackReason).toBe('远端 daemon 尚未就绪')
  })

  it.each(remotePlatformPaths)('retries the original PTY after a transient attach failure at %s', async cwd => {
    mocks.attachTerminal.mockRejectedValueOnce(new Error('daemon handshake timeout'))
    useTerminalStore.setState({ terminals: [terminal({
      status: 'exited', persistent: true, ptyId: 'original-pty', connectionId: 'conn',
      cwd,
      awaitingRestoreSpawn: true, ptySpawnPending: true, launchCommand: 'claude', profileId: 'claude',
    })] })
    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ restoreUnavailable: true })
    expect(useTerminalStore.getState().terminals[0].endedAt).toBeUndefined()
    mocks.attachTerminal.mockResolvedValueOnce({ persistent: true, ptyId: 'original-pty', connectionId: 'conn' })
    await useTerminalStore.getState().reopenTerminalShell('t1')
    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    expect(mocks.attachTerminal).toHaveBeenCalledTimes(2)
    expect(mocks.attachTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ ptyId: 'original-pty' }))
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(mocks.spawnTerminalScript).not.toHaveBeenCalled()
    expect(mocks.killTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ status: 'running', ptyId: 'original-pty', launchCommand: 'claude' })
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
        cols: null,
        rows: null,
      }),
    )
    expect(
      useTerminalStore.getState().terminals.filter(tab => tab.projectId === project.id),
    ).toHaveLength(2)
  })

  it('ends an untouched default detached terminal even when replay would fail', async () => {
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
    mocks.attachTerminal.mockRejectedValueOnce(new Error('pty.attach 重放失败'))
    useTerminalStore.setState({ terminals: [] })

    await useTerminalStore.getState().syncDetachedTerminals(project.id)
    const action = mocks.pushToast.mock.calls[0][3] as {
      onAction: () => Promise<void>
    }
    await action.onAction()

    expect(mocks.killDetachedTerminal).toHaveBeenCalledWith({
      ptyId: 'pty-kill', cwd: project.path,
    })
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
    expect(mocks.killTerminal).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('success', '已结束 1 个远端终端')
  })

  it('retains the ended direct SSH session without silently spawning a shell', async () => {
    useTerminalStore.setState({ terminals: [terminal({ persistent: false })] })
    emit('terminal-exit', {
      id: 't1',
      exitCode: 0,
      disconnected: true,
      reason: 'remote closed',
    })
    expect(useTerminalStore.getState().terminals[0]?.status).toBe('exited')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals[0]?.endedAt).toBeGreaterThan(0)
  })

  it('preserves an unexpected exit and leaves the sibling terminal alive', async () => {
    useTerminalStore.setState({ terminals: [
      terminal({ persistent: true, ptyId: 'old-pty', launchCommand: 'claude', profileId: 'claude' }),
      terminal({ id: 'sibling', persistent: true, ptyId: 'sibling-pty' }),
    ] })
    emit('terminal-exit', { id: 't1', exitCode: 1, disconnected: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ status: 'exited', exitCode: 1, ptyId: 'old-pty' })
    expect(useTerminalStore.getState().terminals[1]).toMatchObject({ status: 'running', ptyId: 'sibling-pty' })
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(mocks.killTerminal).not.toHaveBeenCalled()
    await useTerminalStore.getState().reopenTerminalShell('t1')
    await useTerminalStore.getState().spawnPendingTerminal('t1', 100, 30)
    expect(mocks.spawnTerminalScript).not.toHaveBeenCalled()
    expect(mocks.createTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 't1' }))
    expect(useTerminalStore.getState().terminals[0].launchCommand).toBe('')
  })

  it('does not resurrect a persistent terminal after a confirmed daemon loss', async () => {
    emit('terminal-exit', { id: 't1', exitCode: 0, disconnected: true, reason: 'PTY not found' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ status: 'exited', disconnectReason: 'PTY not found' })
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
  })

  it('keeps terminal input enabled while a persistent connection reconnects', async () => {
    useTerminalStore.setState({
      terminals: [terminal({ status: 'reconnecting', persistent: true })],
    })

    await useTerminalStore.getState().writeToTerminal('t1', 'echo ok\r')

    expect(mocks.writeTerminal).toHaveBeenCalledWith('t1', 'echo ok\r')
  })

  it('records the last active time on submit with a throttle and always on exit', async () => {
    const lastActive = () => useTerminalStore.getState().terminals[0]?.lastActiveAt
    vi.setSystemTime(1_000_000)
    useTerminalStore.setState({ terminals: [terminal()] })
    await useTerminalStore.getState().writeToTerminal('t1', 'ls')
    expect(lastActive()).toBeUndefined()
    await useTerminalStore.getState().writeToTerminal('t1', 'ls\r')
    expect(lastActive()).toBe(1_000_000)
    vi.setSystemTime(1_010_000)
    await useTerminalStore.getState().writeToTerminal('t1', '\r')
    expect(lastActive()).toBe(1_000_000)
    vi.setSystemTime(1_040_000)
    await useTerminalStore.getState().writeToTerminal('t1', '\r')
    expect(lastActive()).toBe(1_040_000)
    vi.setSystemTime(1_045_000)
    emit('terminal-exit', { id: 't1', exitCode: 0, disconnected: false })
    expect(lastActive()).toBe(1_045_000)
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
    // PTY 尺寸变更按最小间隔节流：推进定时器让排队的 resize 下发。
    const resizing = useTerminalStore.getState().resizeTerminal(task.id, 110, 35)
    await vi.advanceTimersByTimeAsync(300)
    await resizing

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

  it.each(remotePlatformPaths)('keeps explicit restart on a task running its original command at %s', async cwd => {
    exitedTask({ cwd, persistent: true, ptyId: 'old-task-pty', connectionId: 'conn' })
    await useTerminalStore.getState().restartTerminal('t1')
    await vi.advanceTimersByTimeAsync(2500)
    expect(mocks.spawnTerminalScript).toHaveBeenCalledWith(expect.objectContaining({
      shellKind: 'command', target: 'uvicorn app:main', env: { TASK_ONLY: '1' },
    }))
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    expect(mocks.attachTerminal).not.toHaveBeenCalled()
  })

})

describe('daemon screen snapshots', () => {
  let unlisten: (() => void) | undefined
  const decode = (chunks: Uint8Array[]) => chunks.map(data => new TextDecoder().decode(data)).join('')
  const output = (id: string, text: string) =>
    emit('terminal-data', { id, data: Array.from(new TextEncoder().encode(text)) })
  const screen = (id: string, data: string, cols = 120, rows = 30) =>
    emit('terminal-screen', { id, data, cols, rows })

  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.listeners.clear()
    useTerminalStore.setState({
      terminals: [terminal({ id: 'snap', cwd: '/tmp/project' })],
      activeTerminalId: 'snap',
      activeTerminalByProject: { p1: 'snap' },
    })
    unlisten = await useTerminalStore.getState().initializeTerminalEvents()
  })

  afterEach(() => {
    unlisten?.()
    vi.useRealTimers()
  })

  it('hands a mounted view the screen with its daemon grid after earlier output', async () => {
    const events: string[] = []
    const unsubscribe = subscribeTerminalOutput(
      'snap',
      data => events.push(`data:${new TextDecoder().decode(data)}`),
      snapshot => events.push(`screen:${snapshot.cols}x${snapshot.rows}:${snapshot.data}`)
    )
    events.length = 0
    output('snap', 'before')
    screen('snap', 'DAEMON')
    output('snap', 'after')
    await vi.runAllTimersAsync()
    unsubscribe()

    expect(events).toEqual(['data:before', 'screen:120x30:DAEMON', 'data:after'])
  })

  it('keeps the screen in the ring for views mounted later', async () => {
    screen('snap', 'DAEMON')
    output('snap', '|live')
    const replay: Uint8Array[] = []
    subscribeTerminalOutput('snap', data => replay.push(data))()
    expect(decode(replay).endsWith('DAEMON|live')).toBe(true)
  })

  it('replays a stored screen with its daemon grid to views mounted later', async () => {
    output('snap', 'history|')
    screen('snap', 'DAEMON', 200, 50)
    output('snap', '|live')
    const events: string[] = []
    subscribeTerminalOutput(
      'snap',
      data => events.push(`data:${new TextDecoder().decode(data)}`),
      snapshot => events.push(`screen:${snapshot.cols}x${snapshot.rows}:${snapshot.data}`)
    )()
    expect(events.at(-2)).toBe('screen:200x50:DAEMON')
    expect(events.at(-1)).toBe('data:|live')
    expect(events.slice(0, -2).join('')).toMatch(/history\|$/)
  })

  it('stops delivering screens after unsubscribe', async () => {
    const screens: unknown[] = []
    subscribeTerminalOutput('snap', () => {}, snapshot => screens.push(snapshot))()
    // 订阅时回放的是先前用例留在 ring 里的快照，只看之后的派发。
    screens.length = 0
    screen('snap', 'LATE')
    await vi.runAllTimersAsync()
    expect(screens).toEqual([])
  })

  it('ignores malformed screen payloads', async () => {
    const screens: unknown[] = []
    const unsubscribe = subscribeTerminalOutput('snap', () => {}, snapshot => screens.push(snapshot))
    screens.length = 0
    emit('terminal-screen', { id: 'snap', data: 'X', cols: 0, rows: 5 })
    emit('terminal-screen', { id: 'snap', data: 42, cols: 40, rows: 5 })
    emit('terminal-screen', { id: 'missing', data: 'X', cols: 40, rows: 5 })
    await vi.runAllTimersAsync()
    unsubscribe()
    expect(screens).toEqual([])
  })
})
