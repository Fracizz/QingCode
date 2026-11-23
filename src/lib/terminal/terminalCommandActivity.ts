/**
 * Per-terminal "foreground command" hints from shell integration (OSC 133 / 633).
 * Complements OS child-process checks used for close/busy UI.
 */

const commandRunning = new Map<string, boolean>()
/** True once we have seen any OSC 133/633 command marker for this session. */
const integrationSeen = new Map<string, boolean>()

/** Shell reports a foreground command started (`OSC 133;C` / `633;C`). */
export function markTerminalCommandStarted(terminalId: string) {
  integrationSeen.set(terminalId, true)
  commandRunning.set(terminalId, true)
}

/** Shell reports the foreground command finished (`OSC 133;D` / `633;D` / prompt). */
export function markTerminalCommandFinished(terminalId: string) {
  integrationSeen.set(terminalId, true)
  commandRunning.set(terminalId, false)
}

export function clearTerminalCommandActivity(terminalId: string) {
  commandRunning.delete(terminalId)
  integrationSeen.delete(terminalId)
}

/** `true` / `false` when shell integration has spoken; otherwise `null`. */
export function getTerminalCommandRunning(terminalId: string): boolean | null {
  if (!integrationSeen.has(terminalId)) return null
  return commandRunning.get(terminalId) === true
}
