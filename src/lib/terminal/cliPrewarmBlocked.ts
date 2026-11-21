import { useProjectStore } from '../../store/projectStore'
import { translate } from '../i18n'
import { sshConnectionIdFromUri } from '../sshWorkspace'

export const CLI_PREWARM_BLOCKED_EVENT = 'cli-prewarm-blocked'

/** 后端预热循环暂停时会弹 Toast 的原因（与 codex.rs 的 interaction_blocker 对应）。 */
const details = new Map([
  ['cli_script_blocked', 'PowerShell 拦截了启动脚本。可将终端配置切换到已安装的 PowerShell 7。'],
  ['cli_upgrade_required', '请打开普通终端处理 CLI 的升级提示。'],
  ['cli_login_required', '请在普通终端中登录 CLI。'],
  ['cli_trust_required', '请在普通终端中处理 CLI 的目录信任提示。'],
  ['cli_handoff_unavailable', '当前 Codex 未报告可识别的就绪状态。请检查 CLI 版本或使用普通终端。'],
  ['cli_not_installed', '未找到 {command} 命令。请先安装，或确认它在 PATH 中，然后切换一次预热配置重试。'],
])

/** 只在设置页显示、不弹 Toast 的暂停原因。 */
const statusOnly = new Map([
  ['cli_not_ready', 'CLI 未能在预热中就绪。请在普通终端中运行一次检查，然后切换一次预热配置重试。'],
  ['codex_not_ready', 'CLI 未能在预热中就绪。请在普通终端中运行一次检查，然后切换一次预热配置重试。'],
  ['profile_exited', 'CLI 预热会话已退出。切换一次预热配置后重试。'],
  ['server_outdated', '远端 QingCode 服务需要更新后才能预热 CLI。'],
])

/** CLI 预热暂停原因的说明；不是 CLI 相关的暂停（如连接未就绪）返回 null。 */
export function cliPrewarmPauseDetail(reason: string | null | undefined, command: string): string | null {
  const detail = reason ? details.get(reason) ?? statusOnly.get(reason) : undefined
  return detail ? translate(detail, { command }) : null
}

const notified = new Set<string>()

export function notifyCliPrewarmBlocked(payload: { cwd?: unknown; command?: unknown; reason?: unknown }) {
  const { command, cwd, reason } = payload
  if (typeof cwd !== 'string' || (command !== 'codex' && command !== 'claude' && command !== 'opencode') || typeof reason !== 'string') return
  const detail = details.get(reason)
  if (!detail) return
  const connectionId = sshConnectionIdFromUri(cwd)
  const key = JSON.stringify([connectionId, command, reason])
  if (notified.has(key)) return
  notified.add(key)
  const state = useProjectStore.getState()
  const name = connectionId && (state.sshConnections.find(connection => connection.id === connectionId)?.name ?? connectionId)
  const title = name
    ? translate('{name} 的 {command} 预热已暂停', { name, command })
    : translate('{command} 预热已暂停', { command })
  state.pushToast('info', title, translate(detail, { command }))
}
