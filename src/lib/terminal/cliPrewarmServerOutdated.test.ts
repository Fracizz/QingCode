import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'
import { notifyCliPrewarmServerOutdated, resetCliPrewarmServerOutdatedNotices } from './cliPrewarmServerOutdated'
import { cliPrewarmPauseDetail, notifyCliPrewarmBlocked } from './cliPrewarmBlocked'

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

  it('按连接和原因提示 CLI 启动阻塞', () => {
    const payload = { cwd: 'ssh://c1/D:/code/a', command: 'codex', reason: 'cli_script_blocked' }
    notifyCliPrewarmBlocked({ ...payload, reason: 'unknown' })
    notifyCliPrewarmBlocked(payload)
    notifyCliPrewarmBlocked({ ...payload, cwd: 'ssh://c1/D:/code/b' })
    expect(pushToast).toHaveBeenCalledExactlyOnceWith('info', expect.stringContaining('windev'), expect.stringContaining('PowerShell 7'))
    notifyCliPrewarmBlocked({ ...payload, reason: 'cli_upgrade_required' })
    expect(pushToast).toHaveBeenCalledTimes(2)
  })

  it('CLI 未安装时提示命令名，OpenCode 同样提示', () => {
    notifyCliPrewarmBlocked({ cwd: 'ssh://c1/D:/code/a', command: 'opencode', reason: 'cli_not_installed' })
    expect(pushToast).toHaveBeenCalledExactlyOnceWith('info', expect.stringContaining('windev'), expect.stringContaining('未找到 opencode 命令'))
  })

  it('设置页只说明 CLI 相关的暂停原因', () => {
    expect(cliPrewarmPauseDetail('cli_not_installed', 'codex')).toContain('未找到 codex 命令')
    expect(cliPrewarmPauseDetail('profile_exited', 'codex')).toContain('已退出')
    expect(cliPrewarmPauseDetail('cli_anchor_busy', 'claude')).toContain('自动重试')
    expect(cliPrewarmPauseDetail('remote_unavailable', 'codex')).toBeNull()
    expect(cliPrewarmPauseDetail(null, 'codex')).toBeNull()
  })
})
