import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeTerminalsForConfig,
  buildRunningMapsFromTerminals,
  findRunLinkageForTerminal,
  isActiveRunTerminal,
  rehydrateRunningFromTerminals,
  runTaskTerminalName,
  stampMissingRunLinkage,
  useRunConfigStore,
  type RunConfig,
} from './runConfigStore'
import { useTerminalStore } from './terminalStore'
import type { TerminalTab } from '../types'

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
    })
    useRunConfigStore.setState({ runningByTask: {}, runningConfigs: {} })
  })

  it('treats awaitingRestoreSpawn as active even when status is exited', () => {
    expect(
      isActiveRunTerminal({ status: 'exited', awaitingRestoreSpawn: true }),
    ).toBe(true)
    expect(
      isActiveRunTerminal({ status: 'exited', awaitingRestoreSpawn: false }),
    ).toBe(false)
    expect(isActiveRunTerminal({ status: 'running' })).toBe(true)
  })

  it('builds running maps only from active stamped terminals', () => {
    const { runningByTask, runningConfigs } = buildRunningMapsFromTerminals([
      { id: 't1', runConfigId: 'cfg', runTaskId: 'a', status: 'running' },
      { id: 't2', runConfigId: 'cfg', runTaskId: 'b', status: 'starting' },
      {
        id: 'awaiting',
        runConfigId: 'cfg',
        runTaskId: 'c',
        status: 'exited',
        awaitingRestoreSpawn: true,
      },
      { id: 'dead', runConfigId: 'cfg', runTaskId: 'd', status: 'exited' },
      { id: 'plain', status: 'running' },
    ])
    expect(runningByTask).toEqual({
      'cfg:a': 't1',
      'cfg:b': 't2',
      'cfg:c': 'awaiting',
    })
    expect(runningConfigs.cfg).toEqual(['cfg:a', 'cfg:b', 'cfg:c'])
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
        sampleConfigs,
      ),
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
        sampleConfigs,
      ),
    ).toEqual({ runConfigId: 'cfg', runTaskId: 'frontend' })
  })

  it('stamps missing linkage and rehydrates running maps after restore', () => {
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

    expect(stampMissingRunLinkage(sampleConfigs)).toBe(2)
    expect(useTerminalStore.getState().terminals[0].runConfigId).toBe('cfg')
    expect(useTerminalStore.getState().terminals[0].runTaskId).toBe('backend')
    expect(useTerminalStore.getState().terminals[1].runConfigId).toBe('cfg')
    expect(useTerminalStore.getState().terminals[1].runTaskId).toBe('frontend')
    expect(useTerminalStore.getState().terminals[2].runConfigId).toBeUndefined()

    rehydrateRunningFromTerminals()
    expect(useRunConfigStore.getState().runningByTask).toEqual({
      'cfg:backend': 't-be',
      'cfg:frontend': 't-fe',
    })
    expect(useRunConfigStore.getState().runningConfigs.cfg).toEqual([
      'cfg:backend',
      'cfg:frontend',
    ])
    expect(activeTerminalsForConfig('cfg', useTerminalStore.getState().terminals)).toEqual([
      't-be',
      't-fe',
    ])
  })

  it('rehydrateRunningFromTerminals accepts configs and stamps in one step', () => {
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
    rehydrateRunningFromTerminals(sampleConfigs)
    expect(useTerminalStore.getState().terminals[0].runConfigId).toBe('cfg')
    expect(useRunConfigStore.getState().runningByTask['cfg:backend']).toBe('t1')
  })
})
