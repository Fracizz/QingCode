import type { TerminalTab } from '@/types'

/** One-shot run-config kinds (not profile interactive). */
export type ScriptShellKind = 'ps1' | 'bat' | 'sh' | 'command' | 'script'

export type TerminalSpawnPlan =
  | { mode: 'shell' }
  | { mode: 'interactive'; command: string }
  | {
      mode: 'script'
      shellKind: ScriptShellKind
      target: string
      env: Record<string, string>
    }

function isScriptShellKind(kind: string): kind is ScriptShellKind {
  return (
    kind === 'ps1' ||
    kind === 'bat' ||
    kind === 'sh' ||
    kind === 'command' ||
    kind === 'script'
  )
}

/**
 * Single decision point for PTY launch.
 * Profile startup commands always use `interactive` (run then keep shell),
 * instead of typing into a bare shell after create_terminal.
 */
export function planTerminalSpawn(
  tab: Pick<TerminalTab, 'launchCommand' | 'shellKind' | 'env'>,
): TerminalSpawnPlan {
  const command = tab.launchCommand.trim()
  if (tab.shellKind && isScriptShellKind(tab.shellKind)) {
    return {
      mode: 'script',
      shellKind: tab.shellKind,
      target: tab.launchCommand,
      env: tab.env ?? {},
    }
  }
  if (command) {
    return { mode: 'interactive', command }
  }
  return { mode: 'shell' }
}
