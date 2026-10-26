import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, switchSshConnectionMode, pushToast, store, confirmDialog } = vi.hoisted(() => ({
  invoke: vi.fn(),
  switchSshConnectionMode: vi.fn(),
  pushToast: vi.fn(),
  confirmDialog: vi.fn(),
  store: {
    currentProject: { id: 'p1', name: 'remote', path: 'ssh://c1/home/u/app' },
    projects: [{ id: 'p9', name: 'other', path: 'ssh://c9/home/u/other' }],
  },
}))

vi.mock('./sshWorkspace', async () => {
  const actual = await vi.importActual<typeof import('./sshWorkspace')>('./sshWorkspace')
  return { ...actual, switchSshConnectionMode }
})

vi.mock('./tauri', () => ({ safeInvoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('../store/confirmStore', () => ({ confirmDialog }))

vi.mock('../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ pushToast, ...store }),
  },
}))

import {
  SERVER_MODE_ERROR_PREFIX,
  isServerModeError,
  serverModeErrorAction,
} from './serverModeError'

const t = (source: string, values?: Record<string, string | number>) =>
  values
    ? source.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in values ? String(values[key]) : match,
      )
    : source

const ready = {
  connectionId: 'c1', rootUri: 'ssh://c1/home/u/app', phase: 'readyServer',
  mode: 'server', connectionMode: 'server', version: '0.1.13', transport: 'daemon', reason: null,
}

describe('isServerModeError', () => {
  it('is false for ordinary and empty errors', () => {
    expect(isServerModeError(new Error('连接超时'))).toBe(false)
    expect(isServerModeError('connection lost')).toBe(false)
    expect(isServerModeError(null)).toBe(false)
    expect(isServerModeError(undefined)).toBe(false)
  })

  it('detects the prefix in strings, Error messages and wrapped failures', () => {
    expect(isServerModeError(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`)).toBe(true)
    expect(isServerModeError(new Error(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`))).toBe(true)
    expect(isServerModeError(`新建终端失败: ${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`)).toBe(true)
  })
})

describe('serverModeErrorAction', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(ready)
    switchSshConnectionMode.mockReset()
    pushToast.mockReset()
    confirmDialog.mockReset().mockResolvedValue(true)
    store.currentProject = { id: 'p1', name: 'remote', path: 'ssh://c1/home/u/app' }
  })

  it('returns undefined for unrelated errors', () => {
    expect(serverModeErrorAction(new Error('断开连接'), ready.rootUri, t)).toBeUndefined()
  })

  it('retries the current SSH project without changing connection mode', async () => {
    const action = serverModeErrorAction(
      new Error(`新建终端失败: ${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`), ready.rootUri, t,
    )
    expect(action?.label).toBe('重启远端服务')
    await action?.onAction()
    expect(confirmDialog).toHaveBeenCalledWith({
      title: '重启远端服务',
      message: '重启会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。',
      kind: 'warning', confirmLabel: '重启', cancelLabel: '取消',
    })
    expect(invoke).toHaveBeenCalledWith('重启远端服务', 'ssh_server_restart', {
      rootUri: 'ssh://c1/home/u/app',
    })
    expect(switchSshConnectionMode).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('success', '已重启远端服务')
  })

  it('uses a project belonging to the explicit connection', async () => {
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, 'ssh://c9/home/u/other', t)
    await action?.onAction()
    expect(invoke).toHaveBeenCalledWith('重启远端服务', 'ssh_server_restart', {
      rootUri: 'ssh://c9/home/u/other',
    })
    expect(serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, 'missing', t)).toBeUndefined()
  })

  it('keeps the original root when the user switches projects before retrying', async () => {
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)
    store.currentProject = { id: 'p9', name: 'other', path: 'ssh://c9/home/u/other' }
    await action?.onAction()
    expect(invoke).toHaveBeenCalledWith('重启远端服务', 'ssh_server_restart', {
      rootUri: 'ssh://c1/home/u/app',
    })
  })

  it('uses the failed operation root even when the current project changed before the error arrived', async () => {
    const failedRoot = ready.rootUri
    store.currentProject = { id: 'p9', name: 'other', path: 'ssh://c9/home/u/other' }
    await serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, failedRoot, t)?.onAction()
    expect(invoke).toHaveBeenCalledWith('重启远端服务', 'ssh_server_restart', { rootUri: failedRoot })
  })

  it('does not choose another project root on the same connection', async () => {
    store.currentProject = { id: 'p2', name: 'sibling', path: 'ssh://c1/home/u/sibling' }
    await serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)?.onAction()
    expect(invoke).toHaveBeenCalledWith('重启远端服务', 'ssh_server_restart', { rootUri: ready.rootUri })
  })

  it('offers no action without a matching SSH project', () => {
    store.currentProject.path = 'D:/code/app'
    expect(serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, store.currentProject.path, t)).toBeUndefined()
  })

  it('reports retry failures without changing mode', async () => {
    invoke.mockRejectedValue(new Error('工作区未信任'))
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)
    await action?.onAction()
    expect(pushToast).toHaveBeenCalledWith('error', '重启远端服务失败: Error: 工作区未信任')
    expect(switchSshConnectionMode).not.toHaveBeenCalled()
  })

  it('does not report a pending deployment as already ready', async () => {
    invoke.mockResolvedValue({ ...ready, phase: 'installing', mode: 'unknown' })
    await serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)?.onAction()
    expect(pushToast).toHaveBeenCalledWith('info', '正在部署远端服务…')
  })

  it('does not restart the service when confirmation is cancelled', async () => {
    confirmDialog.mockResolvedValue(false)
    await serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)?.onAction()
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('waits for explicit confirmation before restarting', async () => {
    let answer: (value: boolean) => void = () => {}
    confirmDialog.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)!
    const completion = action.onAction()
    expect(invoke).not.toHaveBeenCalled()
    answer(true)
    await completion
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('reports a blocked deployment with its reason', async () => {
    invoke.mockResolvedValue({ ...ready, phase: 'readyDirect', mode: 'direct', reason: '工作区未信任' })
    await serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)?.onAction()
    expect(pushToast).toHaveBeenCalledWith('warn', '远端服务尚未就绪', '工作区未信任')
  })

  it('coalesces repeated clicks until the retry settles', async () => {
    let finish: (value: unknown) => void = () => {}
    invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, ready.rootUri, t)!
    const first = action.onAction()
    await action.onAction()
    expect(invoke).toHaveBeenCalledTimes(1)
    finish(ready)
    await first
  })
})
