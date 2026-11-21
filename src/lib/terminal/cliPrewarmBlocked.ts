import { useProjectStore } from '../../store/projectStore'
import { translate } from '../i18n'
import { sshConnectionIdFromUri } from '../sshWorkspace'

export const CLI_PREWARM_BLOCKED_EVENT = 'cli-prewarm-blocked'

const details = new Map([
  ['cli_script_blocked', 'PowerShell 拦截了启动脚本。可将终端配置切换到已安装的 PowerShell 7。'],
  ['cli_upgrade_required', '请打开普通终端处理 CLI 的升级提示。'],
  ['cli_login_required', '请在普通终端中登录 CLI。'],
  ['cli_trust_required', '请在普通终端中处理 CLI 的目录信任提示。'],
  ['cli_handoff_unavailable', '当前 Codex 未报告可识别的就绪状态。请检查 CLI 版本或使用普通终端。'],
])
const notified = new Set<string>()

export function notifyCliPrewarmBlocked(payload: { cwd?: unknown; command?: unknown; reason?: unknown }) {
  const { command, cwd, reason } = payload
  if (typeof cwd !== 'string' || (command !== 'codex' && command !== 'claude') || typeof reason !== 'string') return
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
  state.pushToast('info', title, translate(detail))
}
