/**
 * Per-terminal "foreground command" hints from shell integration (OSC 133 / 633).
 * Complements OS child-process checks used for close/busy UI.
 */

type Listener = (terminalId: string) => void

const commandRunning = new Map<string, boolean>()
/** True once we have seen any OSC 133/633 command marker for this session. */
const integrationSeen = new Map<string, boolean>()
const listeners = new Set<Listener>()

function notify(terminalId: string) {
  for (const listener of listeners) listener(terminalId)
}

/** Shell reports a foreground command started (`OSC 133;C` / `633;C`). */
export function markTerminalCommandStarted(terminalId: string) {
  integrationSeen.set(terminalId, true)
  if (commandRunning.get(terminalId) === true) return
  commandRunning.set(terminalId, true)
  notify(terminalId)
}

/** Shell reports the foreground command finished (`OSC 133;D` / `633;D` / prompt). */
export function markTerminalCommandFinished(terminalId: string) {
  integrationSeen.set(terminalId, true)
  if (commandRunning.get(terminalId) === false) return
  commandRunning.set(terminalId, false)
  notify(terminalId)
}

export function clearTerminalCommandActivity(terminalId: string) {
  const had =
    commandRunning.delete(terminalId) || integrationSeen.delete(terminalId)
  if (had) notify(terminalId)
}

/** `true` / `false` when shell integration has spoken; otherwise `null`. */
export function getTerminalCommandRunning(terminalId: string): boolean | null {
  if (!integrationSeen.has(terminalId)) return null
  return commandRunning.get(terminalId) === true
}

export function subscribeTerminalCommandActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
