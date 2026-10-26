import { beforeEach, describe, expect, it, vi } from 'vitest'

const { switchSshConnectionMode, pushToast, currentProject } = vi.hoisted(() => ({
  switchSshConnectionMode: vi.fn(),
  pushToast: vi.fn(),
  currentProject: { id: 'p1', name: 'remote', path: 'ssh://c1/home/u/app' },
}))

vi.mock('./sshWorkspace', async () => {
  const actual = await vi.importActual<typeof import('./sshWorkspace')>('./sshWorkspace')
  return { ...actual, switchSshConnectionMode }
})

vi.mock('../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ pushToast, currentProject }),
  },
}))

import {
  SERVER_MODE_ERROR_PREFIX,
  isServerModeError,
  serverModeErrorAction,
  switchToSshMode,
} from './serverModeError'

const t = (source: string, values?: Record<string, string | number>) =>
  values
    ? source.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in values ? String(values[key]) : match,
      )
    : source

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

describe('switchToSshMode', () => {
  beforeEach(() => {
    switchSshConnectionMode.mockReset().mockResolvedValue(undefined)
    pushToast.mockReset()
  })

  it('switches the given connection to SSH mode', async () => {
    await switchToSshMode('c1')
    expect(switchSshConnectionMode).toHaveBeenCalledWith('c1', 'ssh')
  })

  it('propagates failures instead of swallowing them', async () => {
    switchSshConnectionMode.mockRejectedValue(new Error('disk full'))
    await expect(switchToSshMode('c1')).rejects.toThrow('disk full')
  })
})

describe('serverModeErrorAction', () => {
  beforeEach(() => {
    switchSshConnectionMode.mockReset().mockResolvedValue(undefined)
    pushToast.mockReset()
  })

  it('returns undefined for unrelated errors', () => {
    expect(serverModeErrorAction(new Error('断开连接'), t)).toBeUndefined()
  })

  it('resolves the connection from the current SSH project', async () => {
    const action = serverModeErrorAction(
      new Error(`新建终端失败: ${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`),
      t,
    )
    expect(action?.label).toBe('切到 SSH 模式')
    await action?.onAction()
    expect(switchSshConnectionMode).toHaveBeenCalledWith('c1', 'ssh')
    expect(pushToast).toHaveBeenCalledWith('success', '已切换到 SSH 模式')
  })

  it('uses the explicit connection id when provided', async () => {
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, t, 'c9')
    await action?.onAction()
    expect(switchSshConnectionMode).toHaveBeenCalledWith('c9', 'ssh')
  })

  it('offers no action when no SSH connection can be resolved', () => {
    const local = { id: 'p2', name: 'local', path: 'D:/code/app' }
    const original = currentProject.path
    currentProject.path = local.path
    try {
      expect(serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, t)).toBeUndefined()
    } finally {
      currentProject.path = original
    }
  })

  it('reports failures from switching as an error toast', async () => {
    switchSshConnectionMode.mockRejectedValue(new Error('disk full'))
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, t)
    await action?.onAction()
    expect(pushToast).toHaveBeenCalledWith(
      'error',
      '切到 SSH 模式失败: Error: disk full',
    )
  })
})
