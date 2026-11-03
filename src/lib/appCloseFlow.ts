import type { TerminalTab } from '../types'
import type { ChoiceRequest } from '../store/choiceStore'
import { translate as t } from './i18n'

export type RemoteExitAction = 'preserve' | 'terminate'

export function hasRemoteSession(tab: TerminalTab): boolean {
  return tab.cwd.startsWith('ssh://') && tab.persistent === true && !!tab.ptyId && !tab.endedAt
}

export function appExitTerminals(tabs: TerminalTab[]): TerminalTab[] {
  return tabs.filter(tab => hasRemoteSession(tab) || (tab.status !== 'exited' && !tab.ptySpawnPending))
}

/** Shared by the native window and Web fixture; only native boundaries are injected. */
export interface AppCloseDependencies {
  pauseSpawns: () => Promise<void>
  resumeSpawns: () => void
  terminals: () => TerminalTab[]
  transferCount: () => number
  choose: (request: ChoiceRequest) => Promise<string | null>
  confirmFiles: () => Promise<boolean>
  finishRemote: (tab: TerminalTab, action: RemoteExitAction) => Promise<void>
  closeTerminal: (tab: TerminalTab) => Promise<void>
  markEnded: (tab: TerminalTab) => void
  markDetached: (tab: TerminalTab) => void
  flush: () => void
  destroy: () => Promise<void>
}

export async function runAppClose(deps: AppCloseDependencies): Promise<void> {
  try {
    await deps.pauseSpawns()
    const tabs = appExitTerminals(deps.terminals())
    const persistent = tabs.filter(hasRemoteSession)
    const local = tabs.filter(tab => !tab.cwd.startsWith('ssh://'))
    const compatible = tabs.filter(tab => tab.cwd.startsWith('ssh://') && !hasRemoteSession(tab))
    const transfers = deps.transferCount()
    const detail = [
      persistent.length > 0 ? t('有 {count} 个远程终端可以保留。保留后远端进程继续运行，重新连接时可接回。默认在连续断开 3 小时后自动结束。', { count: persistent.length }) : '',
      local.length > 0 ? t('{count} 个本地终端将关闭。', { count: local.length }) : '',
      compatible.length > 0 ? t('{count} 个远程终端不支持持久化，退出后将断开。', { count: compatible.length }) : '',
      transfers > 0 ? t('{count} 项文件传输尚未完成，退出后将中断。', { count: transfers }) : '',
    ].filter(Boolean).join('\n\n')
    const action = await deps.choose({
      title: t('退出 QingCode'), message: t('确定要关闭应用程序吗？'), detail,
      options: [
        { id: 'cancel', label: t('取消') },
        ...(persistent.length > 0 ? [
          { id: 'terminate', label: t('结束远程终端并退出'), danger: true },
          { id: 'preserve', label: t('保留远程终端并退出'), primary: true },
        ] : [{ id: 'terminate', label: t('退出'), primary: true }]),
      ],
    })
    if (action !== 'preserve' && action !== 'terminate') return
    if (!(await deps.confirmFiles())) return

    // No terminal side effects before all cancellable save confirmations finish.
    let pending = tabs.filter(tab => !hasRemoteSession(tab) || action === 'terminate')
    let endedCount = 0
    while (pending.length > 0) {
      const results = await Promise.allSettled(pending.map(async tab => {
        if (hasRemoteSession(tab)) await deps.finishRemote(tab, 'terminate')
        else await deps.closeTerminal(tab)
        deps.markEnded(tab)
      }))
      const failures = pending.flatMap((tab, index) => {
        const result = results[index]
        return result.status === 'rejected' ? [{ tab, error: String(result.reason) }] : []
      })
      endedCount += pending.length - failures.length
      if (failures.length === 0) break
      deps.flush()
      const retry = await deps.choose({
        title: t('部分终端未确认结束'),
        message: t('{count} 个终端未确认结束，远端进程可能仍在运行。', { count: failures.length }),
        detail: [
          endedCount > 0 ? t('{count} 个终端已结束，取消退出不会恢复它们。', { count: endedCount }) : '',
          ...failures.map(({ tab, error }) => `${tab.name}: ${error}`),
        ].filter(Boolean).join('\n'),
        options: [
          { id: 'cancel', label: t('取消退出') },
          { id: 'exit', label: t('仍然退出'), danger: true },
          { id: 'retry', label: t('重试'), primary: true },
        ],
      })
      if (retry === 'exit') break
      if (retry !== 'retry') return
      pending = failures.map(({ tab }) => tab)
    }

    // Stop only this window's proxies, including failed kills. Keep their recoverable PTY ids.
    for (const tab of appExitTerminals(deps.terminals()).filter(hasRemoteSession)) {
      await deps.finishRemote(tab, 'preserve')
      deps.markDetached(tab)
    }
    deps.flush()
    await deps.destroy()
  } finally {
    deps.resumeSpawns()
  }
}
