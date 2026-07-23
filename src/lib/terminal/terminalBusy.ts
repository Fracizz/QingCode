import type { TerminalTab } from '@/types'

/** One-shot run-config tasks stay "busy" until the PTY exits. */
export function isOneShotTaskTerminal(
  tab: Pick<TerminalTab, 'shellKind'>,
): boolean {
  const kind = tab.shellKind
  return (
    kind === 'ps1' ||
    kind === 'bat' ||
    kind === 'sh' ||
    kind === 'command' ||
    kind === 'script'
  )
}

/**
 * Combine shell-integration hint + child-process probe.
 * - Integration `true` → busy (even if children not visible yet)
 * - Integration `false` does not force idle (TUIs may omit D while still running)
 * - Children / one-shot tasks still count
 */
export function resolveTerminalBusy(input: {
  status: TerminalTab['status']
  shellKind?: TerminalTab['shellKind']
  commandRunning: boolean | null
  hasMeaningfulChildren: boolean
}): boolean {
  if (input.status === 'exited') return false
  if (isOneShotTaskTerminal(input)) return true
  if (input.commandRunning === true) return true
  return input.hasMeaningfulChildren
}
