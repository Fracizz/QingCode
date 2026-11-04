import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return {
    ...actual,
    isTauri: () => true,
    safeInvoke: vi.fn(),
  }
})

import { safeInvoke } from '../lib/tauri'
import { ensureRunConfigDirectory, useRunConfigStore, type RunConfig } from './runConfigStore'
import { useProjectStore } from './projectStore'
import type { Project } from '../types'

const invoke = vi.mocked(safeInvoke)
const remoteProject: Project = {
  id: 'remote',
  name: 'remote',
  path: 'ssh://server/home/owner/app',
  created_at: 1,
  last_opened_at: 1,
  kind: 'ssh',
}

describe('cross-platform config persistence', () => {
  const initial = useRunConfigStore.getState()
  beforeEach(() => invoke.mockReset())
  afterEach(() => useRunConfigStore.setState(initial, true))

  it('keeps legacy tasks and every OS override through GUI load/save', async () => {
    const configs: RunConfig[] = [
      {
        id: 'dev',
        name: 'dev',
        tasks: [
          { id: 'legacy', type: 'command', target: 'pnpm dev' },
          {
            id: 'api',
            type: 'command',
            target: '',
            os: {
              windows: { target: 'python.exe app.py', env: { OS_VALUE: 'win' } },
              linux: { target: 'python3 app.py', cwd: '' },
              macos: { type: 'sh', target: 'dev.sh' },
            },
          },
        ],
      },
    ]
    let saved = ''
    invoke.mockImplementation(async (_label, command, args) => {
      if (command === 'read_file') return JSON.stringify({ configs })
      if (command === 'write_file') saved = String(args?.content)
      return undefined
    })
    const loaded = await useRunConfigStore.getState().loadConfigs(remoteProject)
    await useRunConfigStore.getState().saveConfigs(remoteProject, loaded)
    expect(JSON.parse(saved).configs[0].tasks).toEqual(configs[0].tasks)
  })

  it('reports malformed OS overrides without falling back to or overwriting a legacy file', async () => {
    invoke.mockResolvedValue(
      JSON.stringify({
        configs: [
          {
            id: 'dev',
            name: 'dev',
            tasks: [{ id: 'api', target: 'echo ok', os: { win32: { target: 'bad' } } }],
          },
        ],
      })
    )
    await expect(useRunConfigStore.getState().loadConfigs(remoteProject)).rejects.toThrow(
      'Unsupported task.os'
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][1]).toBe('read_file')
    expect(useProjectStore.getState().toasts.at(-1)?.text).toContain('运行配置格式错误')
  })
})

describe('ensureRunConfigDirectory', () => {
  beforeEach(() => invoke.mockReset())

  it('creates a missing .qingcode directory through the SSH command mapping', async () => {
    invoke.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(undefined)

    await ensureRunConfigDirectory(remoteProject)

    expect(invoke).toHaveBeenNthCalledWith(1, '检查运行配置目录', 'validate_directory', {
      path: 'ssh://server/home/owner/app/.qingcode',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, '创建运行配置目录', 'create_directory', {
      parent: remoteProject.path,
      name: '.qingcode',
    })
  })

  it('does nothing for a local project', async () => {
    await ensureRunConfigDirectory({ ...remoteProject, path: 'D:/code/app', kind: 'local' })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('batch run-config deletion', () => {
  const initialState = useRunConfigStore.getState()
  const configs: RunConfig[] = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, tasks: [] }))
  const saveConfigs = vi.fn(async (_project: Project, next: RunConfig[]) => {
    useRunConfigStore.setState({ configsByProject: { remote: next } })
  })

  beforeEach(() => {
    saveConfigs.mockClear()
    useProjectStore.setState({ toasts: [] })
    useRunConfigStore.setState({ configsByProject: { remote: configs }, saveConfigs })
  })
  afterEach(() => useRunConfigStore.setState(initialState, true))

  it('writes once and undoes the whole batch in its original order without losing later edits', async () => {
    await useRunConfigStore.getState().removeConfigs(remoteProject, ['a', 'c', 'a', 'missing'])
    expect(saveConfigs).toHaveBeenCalledExactlyOnceWith(remoteProject, [configs[1], configs[3]])
    const toast = useProjectStore.getState().toasts.at(-1)
    expect(toast?.text).toBe('已删除 2 个运行配置')
    expect(useProjectStore.getState().toasts).toHaveLength(1)
    const edited = { ...configs[1], name: 'edited' }
    const added: RunConfig = { id: 'new', name: 'new', tasks: [] }
    useRunConfigStore.setState({ configsByProject: { remote: [edited, configs[3], added] } })
    await toast?.action?.onAction()
    expect(useRunConfigStore.getState().configsByProject.remote).toEqual([
      configs[0],
      edited,
      configs[2],
      configs[3],
      added,
    ])
    await toast?.action?.onAction()
    expect(saveConfigs).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a config recreated before undo', async () => {
    await useRunConfigStore.getState().removeConfigs(remoteProject, ['a', 'c'])
    const undo = useProjectStore.getState().toasts.at(-1)?.action
    const recreated = { ...configs[0], name: 'recreated' }
    useRunConfigStore.setState({
      configsByProject: { remote: [recreated, configs[1], configs[3]] },
    })
    await undo?.onAction()
    expect(useRunConfigStore.getState().configsByProject.remote).toEqual([
      recreated,
      configs[1],
      configs[2],
      configs[3],
    ])
  })

  it('retains configs and offers no undo when persistence fails', async () => {
    saveConfigs.mockRejectedValueOnce(new Error('write failed'))
    await expect(
      useRunConfigStore.getState().removeConfigs(remoteProject, ['a', 'c'])
    ).rejects.toThrow('write failed')
    expect(useRunConfigStore.getState().configsByProject.remote).toEqual(configs)
    expect(useProjectStore.getState().toasts).toEqual([])
  })
})
