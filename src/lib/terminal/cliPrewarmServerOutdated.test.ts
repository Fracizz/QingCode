import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'
import { notifyCliPrewarmServerOutdated, resetCliPrewarmServerOutdatedNotices } from './cliPrewarmServerOutdated'

describe('notifyCliPrewarmServerOutdated', () => {
  const pushToast = vi.fn()
  beforeEach(() => {
    resetCliPrewarmServerOutdatedNotices()
    pushToast.mockReset()
    useProjectStore.setState({ pushToast, sshConnections: [{ id: 'c1', name: 'windev' }] as never })
  })

  it('每条连接只提示一次，并带远程连接入口', () => {
    notifyCliPrewarmServerOutdated('ssh://c1/D:/code/a')
    notifyCliPrewarmServerOutdated('ssh://c1/D:/code/b')
    expect(pushToast).toHaveBeenCalledTimes(1)
    const [kind, text, , action] = pushToast.mock.calls[0]
    expect(kind).toBe('info')
    expect(text).toContain('windev')
    const open = vi.spyOn(useUIStore.getState(), 'openRemoteConnections')
    useUIStore.setState({ openRemoteConnections: open })
    action.onAction()
    expect(open).toHaveBeenCalled()
  })

  it('忽略非 SSH 路径与无效载荷', () => {
    notifyCliPrewarmServerOutdated('D:/code/a')
    notifyCliPrewarmServerOutdated(undefined)
    expect(pushToast).not.toHaveBeenCalled()
  })
})
