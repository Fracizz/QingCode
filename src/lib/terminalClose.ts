import { safeInvoke } from './tauri'
import type { TerminalTab } from '../types'

function isTerminalNotFoundError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return message.includes('terminal not found') || message.includes('not found')
}

/** True when the tab can be closed without two-click confirmation or a dialog. */
export async function canCloseTerminalDirectly(
  terminal: TerminalTab | undefined,
): Promise<boolean> {
  if (!terminal) return false
  if (terminal.status === 'exited') return true
  // Run-config / script terminals are always treated as busy until they exit.
  if (terminal.shellKind) return false
  try {
    const hasChildren = await safeInvoke<boolean>(
      '查询终端子进程',
      'terminal_has_child_processes',
      { id: terminal.id },
    )
    return !hasChildren
  } catch (error) {
    // Backend session already gone → nothing left to terminate.
    if (isTerminalNotFoundError(error)) return true
    return false
  }
}

/** True when a non-idle process (or run task) is still active. */
export async function isTerminalBusy(terminal: TerminalTab): Promise<boolean> {
  return !(await canCloseTerminalDirectly(terminal))
}

/** Terminals that should warn on app/tab bulk close. Idle shells are excluded. */
export async function listBusyTerminals(terminals: TerminalTab[]): Promise<TerminalTab[]> {
  const busy: TerminalTab[] = []
  for (const terminal of terminals) {
    if (await isTerminalBusy(terminal)) busy.push(terminal)
  }
  return busy
}
