import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return {
    ...actual,
    isTauri: () => true,
    safeInvoke: vi.fn(),
  }
})
import {
  activeTerminalsForConfig,
  findRunLinkageForTerminal,
  isConfigRunning,
  isActiveRunTerminal,
  rehydrateRunTerminals,
  removeRunConfig,
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
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      activeTerminalByProject: {},
      addScriptTerminal: originalAddScriptTerminal,
      closeTerminal: originalCloseTerminal,
    })
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
})
