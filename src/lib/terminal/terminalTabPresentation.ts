import { isSshResource } from '@/lib/tauri'
import { terminalShellLabelKey } from '@/lib/terminal/terminalShell'
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
 * 工作台列表行的副标题：异常状态优先，其次启动命令，最后 Shell 类型。
 * 没有可显示内容时返回空串，列表行只占一行名称。
 */
export function terminalSessionMeta(
  t: Pick<TerminalTab, 'status' | 'exitCode' | 'launchCommand' | 'name' | 'resolvedShell'>,
  translate: Translate,
): string {
  if (t.status === 'exited') {
    return t.exitCode === null
      ? translate('已退出')
      : `${translate('已退出')}${translate('（退出码 {code}）', { code: t.exitCode })}`
  }
  if (t.status === 'reconnecting') return translate('正在重新连接…')
  if (t.status === 'starting') return translate('正在启动…')
  const command = t.launchCommand.trim()
  if (command && command !== t.name) return command
  return t.resolvedShell ? translate(terminalShellLabelKey(t.resolvedShell)) : ''
}
