import { isSshResource } from '@/lib/tauri'
import { terminalShellLabelKey } from '@/lib/terminal/terminalShell'
import { formatFullCreatedTime } from '@/lib/terminal/terminalOverview'
import type { InfoTipDetails } from '@/lib/infoTip'
import type { TerminalTab } from '../../types'

type Translate = (source: string, values?: Record<string, string | number>) => string

/** 终端标签和工作台列表行共用的悬停说明：名称、启动命令、Shell 与连接状态。 */
export function terminalTabTooltip(t: TerminalTab, translate: Translate): string {
  const persistentWarning =
    isSshResource(t.cwd) && t.persistent !== true && t.status !== 'starting'
  return [
    t.launchCommand.trim() && t.launchCommand.trim() !== t.name
      ? `${t.name}\n> ${t.launchCommand.trim()}`
      : t.name,
    t.resolvedShell
      ? `${translate('Shell')}: ${translate(terminalShellLabelKey(t.resolvedShell))}`
      : null,
    t.status === 'exited' && t.awaitingRestoreSpawn ? translate('切换到项目后恢复') : null,
    t.status === 'reconnecting' ? translate('正在重新连接…') : null,
    persistentWarning ? translate('此终端断线会结束远端进程') : null,
    persistentWarning && t.persistentFallbackReason
      ? translate('未能持久化：{reason}', { reason: t.persistentFallbackReason })
      : persistentWarning && t.disconnectReason
        ? translate('断开原因：{reason}', { reason: t.disconnectReason })
        : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/**
 * 工作台列表行尾的异常状态短词；正常运行时返回 null。
 * 等待恢复不算异常：重启应用后尚未打开过的项目，进程并没有退出，由弱化名称和悬停卡片表达。
 */
export function terminalRowStatus(
  t: Pick<TerminalTab, 'status' | 'awaitingRestoreSpawn'>,
  translate: Translate,
): string | null {
  if (t.status === 'exited') return t.awaitingRestoreSpawn ? null : translate('已退出')
  if (t.status === 'reconnecting') return translate('重连中')
  if (t.status === 'starting') return translate('启动中')
  return null
}

function terminalHoverStatus(t: TerminalTab, translate: Translate): InfoTipDetails['status'] {
  if (t.status === 'exited' && t.awaitingRestoreSpawn) {
    return { text: translate('切换到项目后恢复'), tone: 'muted' }
  }
  if (t.status === 'exited') {
    return t.exitCode === null
      ? { text: translate('已退出'), tone: 'muted' }
      : {
          text: `${translate('已退出')}${translate('（退出码 {code}）', { code: t.exitCode })}`,
          tone: t.exitCode === 0 ? 'muted' : 'danger',
        }
  }
  if (t.status === 'reconnecting') return { text: translate('正在重新连接…'), tone: 'warn' }
  if (t.status === 'starting') return { text: translate('正在启动…'), tone: 'muted' }
  return undefined
}

/** 工作台列表行的悬停卡片：列表行放不下的命令、Shell、创建时间和断线行为。 */
export function terminalHoverDetails(
  t: TerminalTab,
  fullCreatedTime: string | null,
  translate: Translate,
): InfoTipDetails {
  const command = t.launchCommand.trim()
  const reason = t.persistentFallbackReason || t.disconnectReason
  // 只显示真实记录过的活动；旧快照没有记录时不拿创建时间冒充。
  const lastActive = formatFullCreatedTime(t.lastActiveAt)
  return {
    title: t.name,
    status: terminalHoverStatus(t, translate),
    rows: [
      ...(command && command !== t.name
        ? [{ label: translate('启动命令'), value: command, mono: true }]
        : []),
      ...(t.resolvedShell
        ? [{ label: translate('Shell'), value: translate(terminalShellLabelKey(t.resolvedShell)) }]
        : []),
      ...(fullCreatedTime ? [{ label: translate('创建时间'), value: fullCreatedTime }] : []),
      ...(lastActive ? [{ label: translate('最后活动'), value: lastActive }] : []),
      ...(isSshResource(t.cwd) && t.status !== 'starting'
        ? [
            {
              label: translate('断线后'),
              value:
                t.persistent === true
                  ? translate('继续运行')
                  : reason
                    ? `${translate('结束远端进程')}：${reason}`
                    : translate('结束远端进程'),
            },
          ]
        : []),
    ],
  }
}
