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
