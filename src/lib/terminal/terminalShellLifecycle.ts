import type { TerminalTab } from '@/types'

/**
 * OpenCode (and similar TUIs) often tear down the whole ConPTY on exit.
 * Interactive shells / profile tabs should get a fresh prompt instead of
 * staying on「进程已退出」. One-shot run-config tasks stay exited.
 */
export function shouldKeepShellAfterExit(
  tab: Pick<TerminalTab, 'shellKind' | 'launchCommand' | 'profileId'>,
): boolean {
  if (tab.shellKind && tab.shellKind !== 'interactive') return false
  return true
}

/**
 * What to do when a restored view mounts on an exited tab.
 * A still-open session is not a disconnect. An interactive shell whose
 * process is gone is started again. Only a finished one-shot task stays locked.
 */
export function restoredExitRecovery(options: {
  awaitingRestoreSpawn: boolean
  sessionOpen: boolean
  keepShell: boolean
}): 'await-spawn' | 'reattach' | 'respawn' | 'locked' {
  if (options.awaitingRestoreSpawn) return 'await-spawn'
  if (options.sessionOpen) return 'reattach'
  if (options.keepShell) return 'respawn'
  return 'locked'
}
