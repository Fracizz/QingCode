import type { TerminalTab } from '@/types'
import { plainTerminalText, terminalReader, type TerminalContentScope } from './terminalContent'

const DEFAULT_TAIL_LINES = 200
/** 单次响应上限，避免一次读取把完整历史塞进一行 IPC。 */
const MAX_OUTPUT_CHARS = 1_000_000

/** 只保留结尾内容；按字符截断时丢弃不完整的首行。 */
export function tailTerminalText(text: string, tail = DEFAULT_TAIL_LINES) {
  const all = text === '' ? [] : text.split('\n')
  let output = all.slice(-tail).join('\n')
  let truncated = Math.min(tail, all.length) < all.length
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(-MAX_OUTPUT_CHARS)
    const newline = output.indexOf('\n')
    if (newline >= 0) output = output.slice(newline + 1)
    truncated = true
  }
  return {
    text: output,
    lines: output === '' ? 0 : output.split('\n').length,
    totalLines: all.length,
    truncated,
  }
}

/** 项目未打开时终端没有 xterm 实例，`rawFallback` 提供原始输出，结果标记为近似。 */
export async function readCliTerminal(
  id: string,
  scope: TerminalContentScope,
  tail?: number,
  rawFallback?: () => string
) {
  const reader = terminalReader(id)
  if (reader) {
    return { available: true, approximate: false, ...tailTerminalText(await reader(scope), tail) }
  }
  const raw = rawFallback?.() ?? ''
  return { available: raw !== '', approximate: true, ...tailTerminalText(plainTerminalText(raw), tail) }
}

/** 重新启动后旧的已退出标签仍在；每个任务只取存活的，否则取最新的。 */
export function latestRunTerminals<T extends Pick<TerminalTab, 'runTaskId' | 'status' | 'createdAt'>>(
  terminals: readonly T[]
): T[] {
  const latest = new Map<string | undefined, T>()
  for (const terminal of terminals) {
    const current = latest.get(terminal.runTaskId)
    const alive = terminal.status !== 'exited'
    const currentAlive = current?.status !== 'exited'
    const better =
      !current ||
      (alive && !currentAlive) ||
      (alive === currentAlive && (terminal.createdAt ?? 0) >= (current.createdAt ?? 0))
    if (better) latest.set(terminal.runTaskId, terminal)
  }
  return terminals.filter(terminal => latest.get(terminal.runTaskId) === terminal)
}

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
