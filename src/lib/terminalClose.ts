import { safeInvoke } from './tauri'
import type { TerminalTab } from '../types'
import { resolveTerminalBusy } from './terminalBusy'
import { getTerminalCommandRunning } from './terminalCommandActivity'

function isTerminalNotFoundError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return message.includes('terminal not found') || message.includes('not found')
}

async function hasMeaningfulChildProcesses(terminalId: string): Promise<boolean> {
  try {
    return await safeInvoke<boolean>('查询终端子进程', 'terminal_has_child_processes', {
      id: terminalId,
    })
  } catch (error) {
    // Backend session already gone → nothing left to terminate.
    if (isTerminalNotFoundError(error)) return false
    // Fail closed for close confirmation (prefer asking once).
    return true
  }
}

/** True when the tab can be closed without two-click confirmation or a dialog. */
export async function canCloseTerminalDirectly(
  terminal: TerminalTab | undefined,
): Promise<boolean> {
  if (!terminal) return false
  return !(await isTerminalBusy(terminal))
}

/** True when a foreground command / run task / meaningful child is active. */
export async function isTerminalBusy(terminal: TerminalTab): Promise<boolean> {
  if (terminal.status === 'exited') return false
  const hasMeaningfulChildren = await hasMeaningfulChildProcesses(terminal.id)
  return resolveTerminalBusy({
    status: terminal.status,
    shellKind: terminal.shellKind,
    commandRunning: getTerminalCommandRunning(terminal.id),
    hasMeaningfulChildren,
  })
}

/** Terminals that should warn on app/tab bulk close. Idle shells are excluded. */
export async function listBusyTerminals(terminals: TerminalTab[]): Promise<TerminalTab[]> {
  const busy: TerminalTab[] = []
  for (const terminal of terminals) {
    if (await isTerminalBusy(terminal)) busy.push(terminal)
  }
  return busy
}
