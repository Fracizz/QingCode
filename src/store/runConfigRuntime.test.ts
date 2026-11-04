import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return {
    ...actual,
    isTauri: () => true,
    safeInvoke: vi.fn(),
  }
})
vi.mock('../lib/runEnvironment', () => ({
  getRunEnvironment: vi.fn(async () => ({ os: 'windows', kind: 'local' })),
}))
import { getRunEnvironment } from '../lib/runEnvironment'
import {
  activeTerminalsForConfig,
  applyRunConfigSessionRestorePolicy,
  findRunLinkageForTerminal,
  isConfigRunning,
  isActiveRunTerminal,
  rehydrateRunTerminals,
  removeRunConfig,
  removeRunConfigs,
  resolveRunTaskCwd,
  runConfig,
  runTaskTerminalName,
  runningTaskKeysForConfig,
  stopConfig,
  taskTerminalId,
} from '../lib/runConfigRuntime'
import { useRunConfigStore, type RunConfig } from './runConfigStore'
import { useTerminalStore } from './terminalStore'
import { useProjectStore } from './projectStore'
import type { TerminalTab } from '../types'

const originalAddScriptTerminal = useTerminalStore.getState().addScriptTerminal
const originalCloseTerminal = useTerminalStore.getState().closeTerminal

const sampleConfigs: RunConfig[] = [
  {
    id: 'cfg',
    name: '前后端',
    tasks: [
      { id: 'backend', name: '后端', type: 'command', target: 'uvicorn app:main' },
      { id: 'frontend', name: '前端', type: 'command', target: 'pnpm dev' },
    ],
  },
]

function baseTab(partial: Partial<TerminalTab> & Pick<TerminalTab, 'id' | 'name'>): TerminalTab {
  return {
    projectId: 'p1',
    cwd: 'D:/proj',
    launchCommand: '',
    status: 'running',
    exitCode: null,
    ...partial,
  }
}

describe('run config runtime helpers', () => {
  beforeEach(() => {
    vi.mocked(getRunEnvironment).mockResolvedValue({ os: 'windows', kind: 'local' })
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      activeTerminalByProject: {},
      addScriptTerminal: originalAddScriptTerminal,
      closeTerminal: originalCloseTerminal,
    })
  })

  it('resolves SSH task working directories without dropping the connection URI', () => {
    const project = { path: 'ssh://server/home/owner/app' }
    expect(resolveRunTaskCwd(project)).toBe('ssh://server/home/owner/app')
    expect(resolveRunTaskCwd(project, 'backend')).toBe('ssh://server/home/owner/app/backend')
    expect(resolveRunTaskCwd(project, '.\\scripts\\')).toBe('ssh://server/home/owner/app/scripts')
    expect(resolveRunTaskCwd(project, '/opt/service/')).toBe('ssh://server/opt/service')
    expect(resolveRunTaskCwd(project, 'ssh://other/tmp/project')).toBe('ssh://other/tmp/project')
  })

  it('keeps local task working-directory behavior', () => {
    expect(resolveRunTaskCwd({ path: 'D:\\project' }, 'frontend')).toBe('D:\\project\\frontend')
    expect(resolveRunTaskCwd({ path: '/home/owner/app' }, '/tmp/task')).toBe('/tmp/task')
  })

  it('maps Linux absolute cwd into the same WSL distribution', () => {
    expect(
      resolveRunTaskCwd({ path: String.raw`\\wsl$\Ubuntu\home\app` }, '/home/app/backend')
    ).toBe(String.raw`\\wsl.localhost\Ubuntu\home\app\backend`)
  })

  it('uses Linux overrides for WSL tasks and rejects unmatched OS before creating tabs', async () => {
    vi.mocked(getRunEnvironment).mockResolvedValue({ os: 'linux', kind: 'wsl', distro: 'Ubuntu' })
    const add = vi.fn().mockResolvedValue('new-terminal')
    useTerminalStore.setState({ addScriptTerminal: add })
    const project = {
      id: 'p1',
      name: 'app',
      path: String.raw`\\wsl$\Ubuntu\home\app`,
      ephemeral: true,
      created_at: 1,
      last_opened_at: 1,
    }
    const config: RunConfig = {
      id: 'dev',
      name: 'dev',
      tasks: [
        {
          id: 'api',
          type: 'command',
          target: 'windows-command',
          env: { BASE: 'yes' },
          os: { linux: { target: 'linux-command', cwd: 'api', env: { MODE: 'linux' } } },
        },
      ],
    }
    const result = await runConfig(project, config, { throwOnError: true })
    expect(result?.environment).toEqual({ os: 'linux', kind: 'wsl', distro: 'Ubuntu' })
    expect(add).toHaveBeenCalledWith(
      'p1',
      `${project.path}\\api`,
      'command',
      'linux-command',
      { BASE: 'yes', MODE: 'linux' },
      'dev',
      { runConfigId: 'dev', runTaskId: 'api' }
    )
    add.mockClear()
    await expect(
      runConfig(
        project,
        {
          ...config,
          tasks: [
            ...config.tasks,
            { id: 'bad', type: 'command', target: '', os: { windows: { target: 'windows-only' } } },
          ],
        },
        { throwOnError: true }
      )
    ).rejects.toThrow('linux')
    expect(add).not.toHaveBeenCalled()
  })

  it('treats awaitingRestoreSpawn as active even when status is exited', () => {
    expect(isActiveRunTerminal({ status: 'exited', awaitingRestoreSpawn: true })).toBe(true)
    expect(isActiveRunTerminal({ status: 'exited', awaitingRestoreSpawn: false })).toBe(false)
    expect(isActiveRunTerminal({ status: 'running' })).toBe(true)
  })

  it('derives running task state only from active stamped terminals', () => {
    useTerminalStore.setState({
      terminals: [
        baseTab({ id: 't1', name: 'one', runConfigId: 'cfg', runTaskId: 'a', status: 'running' }),
        baseTab({ id: 't2', name: 'two', runConfigId: 'cfg', runTaskId: 'b', status: 'starting' }),
        baseTab({
          id: 'awaiting',
          name: 'awaiting',
          runConfigId: 'cfg',
          runTaskId: 'c',
          status: 'exited',
          awaitingRestoreSpawn: true,
        }),
        baseTab({ id: 'dead', name: 'dead', runConfigId: 'cfg', runTaskId: 'd', status: 'exited' }),
        baseTab({ id: 'plain', name: 'plain', status: 'running' }),
      ],
    })
    expect(runningTaskKeysForConfig('cfg')).toEqual(['cfg:a', 'cfg:b', 'cfg:c'])
    expect(taskTerminalId('cfg', 'b')).toBe('t2')
    expect(isConfigRunning('cfg')).toBe(true)
  })

  it('builds stable task tab names for spawn and legacy relink', () => {
    expect(runTaskTerminalName({ name: '前后端' }, { name: '后端' })).toBe('前后端 · 后端')
    expect(runTaskTerminalName({ name: '前后端' }, {})).toBe('前后端')
  })

  it('isolates identical dev/task IDs across projects when stopping', async () => {
    useTerminalStore.setState({
      terminals: [
        baseTab({
          id: 'local',
          name: 'dev',
          projectId: 'local-project',
          runConfigId: 'dev',
          runTaskId: 'api',
        }),
        baseTab({
          id: 'wsl',
          name: 'dev',
          projectId: 'wsl-project',
          runConfigId: 'dev',
          runTaskId: 'api',
        }),
      ],
      closeTerminal: vi.fn(async id => {
        useTerminalStore.setState(state => ({
          terminals: state.terminals.filter(t => t.id !== id),
        }))
      }),
    })
    expect(taskTerminalId('dev', 'api', 'wsl-project')).toBe('wsl')
    await stopConfig({ id: 'dev' }, 'wsl-project')
    expect(useTerminalStore.getState().terminals.map(t => t.id)).toEqual(['local'])
    expect(isConfigRunning('dev', 'wsl-project')).toBe(false)
    expect(isConfigRunning('dev', 'local-project')).toBe(true)
  })

  it('reports a stop failure if the terminal remains alive', async () => {
    useTerminalStore.setState({
      terminals: [baseTab({ id: 'live', name: 'dev', runConfigId: 'dev' })],
      closeTerminal: vi.fn(async () => {}),
    })
    await expect(stopConfig({ id: 'dev' }, 'p1')).rejects.toThrow('未能停止')
    expect(isConfigRunning('dev', 'p1')).toBe(true)
  })

  it('recovers linkage from tab name when ids were not persisted', () => {
    expect(
      findRunLinkageForTerminal(
        {
          name: '前后端 · 后端',
          launchCommand: 'uvicorn app:main',
          shellKind: 'command',
        },
        sampleConfigs
      )
    ).toEqual({ runConfigId: 'cfg', runTaskId: 'backend' })
  })

  it('recovers linkage from unique launchCommand as a fallback', () => {
    expect(
      findRunLinkageForTerminal(
        {
          name: 'renamed',
          launchCommand: 'pnpm dev',
          shellKind: 'command',
        },
        sampleConfigs
      )
    ).toEqual({ runConfigId: 'cfg', runTaskId: 'frontend' })
  })

  it('stamps missing linkage and derives running state after restore', () => {
    useTerminalStore.setState({
      terminals: [
        baseTab({
          id: 't-be',
          name: '前后端 · 后端',
          launchCommand: 'uvicorn app:main',
          shellKind: 'command',
          status: 'running',
        }),
        baseTab({
          id: 't-fe',
          name: '前后端 · 前端',
          launchCommand: 'pnpm dev',
          shellKind: 'command',
          status: 'exited',
          awaitingRestoreSpawn: true,
        }),
        baseTab({
          id: 'shell',
          name: 'PowerShell 7',
          shellKind: 'interactive',
          status: 'running',
        }),
      ],
    })

    expect(rehydrateRunTerminals(sampleConfigs)).toBe(2)
    expect(useTerminalStore.getState().terminals[0].runConfigId).toBe('cfg')
    expect(useTerminalStore.getState().terminals[0].runTaskId).toBe('backend')
    expect(useTerminalStore.getState().terminals[1].runConfigId).toBe('cfg')
    expect(useTerminalStore.getState().terminals[1].runTaskId).toBe('frontend')
    expect(useTerminalStore.getState().terminals[2].runConfigId).toBeUndefined()

    expect(runningTaskKeysForConfig('cfg')).toEqual(['cfg:backend', 'cfg:frontend'])
    expect(activeTerminalsForConfig('cfg', useTerminalStore.getState().terminals)).toEqual([
      't-be',
      't-fe',
    ])
  })

  it('rehydrateRunTerminals accepts configs and stamps in one step', () => {
    useTerminalStore.setState({
      terminals: [
        baseTab({
          id: 't1',
          name: '前后端 · 后端',
          launchCommand: 'uvicorn app:main',
          shellKind: 'command',
          status: 'running',
        }),
      ],
    })
    rehydrateRunTerminals(sampleConfigs)
    expect(useTerminalStore.getState().terminals[0].runConfigId).toBe('cfg')
    expect(taskTerminalId('cfg', 'backend')).toBe('t1')
  })

  it('drops only pending restored terminals for configs that disabled session restore', async () => {
    const closeTerminal = vi.fn(async (id: string) => {
      useTerminalStore.setState(state => ({
        terminals: state.terminals.filter(terminal => terminal.id !== id),
      }))
    })
    useTerminalStore.setState({
      terminals: [
        baseTab({
          id: 'disabled-restored',
          name: 'disabled',
          runConfigId: 'disabled',
          runTaskId: 'task',
          status: 'exited',
          awaitingRestoreSpawn: true,
        }),
        baseTab({
          id: 'enabled-restored',
          name: 'enabled',
          runConfigId: 'enabled',
          runTaskId: 'task',
          status: 'exited',
          awaitingRestoreSpawn: true,
        }),
        baseTab({
          id: 'disabled-running',
          name: 'still running',
          runConfigId: 'disabled',
          runTaskId: 'task',
          status: 'running',
        }),
      ],
      closeTerminal,
    })

    const removed = await applyRunConfigSessionRestorePolicy('p1', [
      { id: 'disabled', name: 'disabled', restoreWithProjectSession: false, tasks: [] },
      { id: 'enabled', name: 'enabled', restoreWithProjectSession: true, tasks: [] },
    ])

    expect(removed).toBe(1)
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('disabled-restored')
    expect(useTerminalStore.getState().terminals.map(terminal => terminal.id)).toEqual([
      'enabled-restored',
      'disabled-running',
    ])
  })

  it('runs, stops, and starts a multi-task configuration again', async () => {
    let sequence = 0
    const addScriptTerminal: typeof originalAddScriptTerminal = async (
      projectId,
      cwd,
      shellKind,
      target,
      env,
      name,
      linkage
    ) => {
      const id = `terminal-${++sequence}`
      useTerminalStore.setState(state => ({
        terminals: [
          ...state.terminals,
          baseTab({
            id,
            name,
            projectId,
            cwd,
            launchCommand: target,
            shellKind,
            env,
            runConfigId: linkage?.runConfigId,
            runTaskId: linkage?.runTaskId,
          }),
        ],
        activeTerminalId: id,
        activeTerminalByProject: { ...state.activeTerminalByProject, [projectId]: id },
      }))
      return id
    }
    const closeTerminal: typeof originalCloseTerminal = async id => {
      useTerminalStore.setState(state => ({
        terminals: state.terminals.filter(terminal => terminal.id !== id),
      }))
    }
    useTerminalStore.setState({ addScriptTerminal, closeTerminal })

    const project = {
      id: 'p1',
      name: 'project',
      path: 'D:/project',
      created_at: 1,
      last_opened_at: 1,
      ephemeral: true,
    }
    const config = sampleConfigs[0]

    await runConfig(project, config)
    expect(useTerminalStore.getState().terminals).toHaveLength(2)
    expect(useTerminalStore.getState().terminals.map(terminal => terminal.name)).toEqual([
      '前后端 · 后端',
      '前后端 · 前端',
    ])
    expect(runningTaskKeysForConfig('cfg')).toEqual(['cfg:backend', 'cfg:frontend'])
    expect(isConfigRunning('cfg')).toBe(true)

    await stopConfig(config)
    expect(useTerminalStore.getState().terminals).toEqual([])
    expect(runningTaskKeysForConfig('cfg')).toEqual([])
    expect(isConfigRunning('cfg')).toBe(false)

    await runConfig(project, config)
    expect(useTerminalStore.getState().terminals.map(terminal => terminal.id)).toEqual([
      'terminal-3',
      'terminal-4',
    ])
    expect(isConfigRunning('cfg')).toBe(true)
  })

  it('keeps a deleted configuration recoverable through the undo toast', async () => {
    const project = {
      id: 'p1',
      name: 'project',
      path: 'D:/project',
      created_at: 1,
      last_opened_at: 1,
      ephemeral: true,
    }
    const saveConfigs = vi.fn(async (_project, configs: RunConfig[]) => {
      useRunConfigStore.setState({ configsByProject: { p1: configs } })
    })
    const closeTerminal = vi.fn(async (id: string) => {
      useTerminalStore.setState(state => ({
        terminals: state.terminals.filter(terminal => terminal.id !== id),
      }))
    })
    useProjectStore.setState({ toasts: [] })
    useTerminalStore.setState({
      terminals: [
        baseTab({
          id: 'running',
          name: '前后端 · 后端',
          runConfigId: 'cfg',
          runTaskId: 'backend',
        }),
      ],
      closeTerminal,
    })
    useRunConfigStore.setState({
      configsByProject: { p1: sampleConfigs },
      saveConfigs,
    })

    await removeRunConfig(project, 'cfg')

    expect(closeTerminal).toHaveBeenCalledWith('running')
    expect(useRunConfigStore.getState().configsByProject.p1).toEqual([])
    const undoToast = useProjectStore.getState().toasts.at(-1)
    expect(undoToast?.text).toContain('已删除运行配置')
    expect(undoToast?.action?.label).toBe('撤销')

    await undoToast?.action?.onAction()
    expect(useRunConfigStore.getState().configsByProject.p1).toEqual(sampleConfigs)
  })

  it('stops only selected configs before persisting a batch deletion once', async () => {
    const project = {
      id: 'p1',
      name: 'project',
      path: 'D:/project',
      created_at: 1,
      last_opened_at: 1,
    }
    const configs: RunConfig[] = ['a', 'b', 'c'].map(id => ({ id, name: id, tasks: [] }))
    const events: string[] = []
    const closeTerminal = vi.fn(async (id: string) => {
      events.push(id)
      useTerminalStore.setState(state => ({
        terminals: state.terminals.filter(terminal => terminal.id !== id),
      }))
    })
    const saveConfigs = vi.fn(async (_project, next: RunConfig[]) => {
      events.push('save')
      useRunConfigStore.setState({ configsByProject: { p1: next } })
    })
    useRunConfigStore.setState({ configsByProject: { p1: configs }, saveConfigs })
    useProjectStore.setState({ toasts: [] })
    useTerminalStore.setState({
      closeTerminal,
      terminals: ['a', 'b', 'c'].map(id => baseTab({ id, name: id, runConfigId: id })),
    })

    await removeRunConfigs(project, ['a', 'c', 'a', 'missing'])

    expect(closeTerminal).toHaveBeenCalledTimes(2)
    expect(events).toEqual(['a', 'c', 'save'])
    expect(useTerminalStore.getState().terminals.map(terminal => terminal.id)).toEqual(['b'])
    expect(saveConfigs).toHaveBeenCalledExactlyOnceWith(project, [configs[1]])
    expect(useProjectStore.getState().toasts).toHaveLength(1)
  })
})
