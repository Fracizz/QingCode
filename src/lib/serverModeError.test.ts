import { beforeEach, describe, expect, it, vi } from 'vitest'

const { switchGlobalSshServerMode, pushToast, currentProject } = vi.hoisted(() => ({
  switchGlobalSshServerMode: vi.fn(),
  pushToast: vi.fn(),
  currentProject: { id: 'p1', name: 'remote', path: 'ssh://c1/home/u/app' },
}))

vi.mock('./sshServerSettings', () => ({ switchGlobalSshServerMode }))

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
    switchGlobalSshServerMode.mockReset().mockResolvedValue(undefined)
    pushToast.mockReset()
  })

  it('switches globally and passes the current project to clear its override', async () => {
    await switchToSshMode()
    expect(switchGlobalSshServerMode).toHaveBeenCalledWith(false, currentProject)
  })

  it('propagates failures instead of swallowing them', async () => {
    switchGlobalSshServerMode.mockRejectedValue(new Error('disk full'))
    await expect(switchToSshMode()).rejects.toThrow('disk full')
  })
})

describe('serverModeErrorAction', () => {
  beforeEach(() => {
    switchGlobalSshServerMode.mockReset().mockResolvedValue(undefined)
    pushToast.mockReset()
  })

  it('returns undefined for unrelated errors', () => {
    expect(serverModeErrorAction(new Error('断开连接'), t)).toBeUndefined()
  })

  it('offers the switch action and reports success', async () => {
    const action = serverModeErrorAction(
      new Error(`新建终端失败: ${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`),
      t,
    )
    expect(action?.label).toBe('切到 SSH 模式')
    await action?.onAction()
    expect(switchGlobalSshServerMode).toHaveBeenCalledWith(false, currentProject)
    expect(pushToast).toHaveBeenCalledWith('success', '已切换到 SSH 模式')
  })

  it('reports failures from switching as an error toast', async () => {
    switchGlobalSshServerMode.mockRejectedValue(new Error('disk full'))
    const action = serverModeErrorAction(`${SERVER_MODE_ERROR_PREFIX}daemon 未就绪`, t)
    await action?.onAction()
    expect(pushToast).toHaveBeenCalledWith(
      'error',
      '切到 SSH 模式失败: Error: disk full',
    )
  })
})
