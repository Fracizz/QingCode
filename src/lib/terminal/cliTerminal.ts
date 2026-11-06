import type { TerminalTab } from '@/types'

/** CLI 只暴露定位和判断可写所需的字段；不含环境变量和启动命令。 */
export function cliTerminalSummary(terminal: TerminalTab) {
  return {
    id: terminal.id,
    name: terminal.name,
    status: terminal.status,
    exitCode: terminal.exitCode,
    cwd: terminal.cwd,
    writable: cliTerminalBlockedReason(terminal) === null,
    runConfigId: terminal.runConfigId,
    runTaskId: terminal.runTaskId,
  }
}

/** 只在所选项目内查找，避免 ID 或重名把输入发到其他项目的终端。 */
export function resolveCliTerminal(
  terminals: readonly TerminalTab[],
  projectId: string,
  query: string
): TerminalTab {
  const q = query.trim()
  const scoped = terminals.filter(terminal => terminal.projectId === projectId)
  const byId = scoped.find(terminal => terminal.id === q)
  if (byId) return byId
  const byName = scoped.filter(terminal => terminal.name === q)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`ambiguous terminal name '${q}'; use the terminal id`)
  throw new Error(`terminal not found in project: ${q}`)
}

function cliTerminalBlockedReason(terminal: TerminalTab): string | null {
  if (terminal.status !== 'running') return terminal.status
  if (terminal.ptySpawnPending) return 'starting'
  return null
}

/** 启动、重连或已退出时输入可能丢失，或落到之后恢复的新进程里，因此直接拒绝。 */
export function assertCliTerminalWritable(terminal: TerminalTab): void {
  const reason = cliTerminalBlockedReason(terminal)
  if (reason) throw new Error(`terminal is not writable (${reason}): ${terminal.id}`)
}
