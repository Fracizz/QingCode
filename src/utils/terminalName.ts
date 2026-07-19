function formatTerminalNumber(name: string): string | null {
  if (/^终端 \d+$/.test(name)) return name
  const match = /^Terminal (\d+)$/.exec(name)
  return match ? `终端 ${match[1]}` : null
}

function shortenTerminalLabel(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name
  if (/^powershell(\.exe)?$/i.test(base)) return 'PowerShell'
  if (/^pwsh(\.exe)?$/i.test(base)) return 'PowerShell 7'
  if (/^cmd(\.exe)?$/i.test(base)) return '命令提示符'
  if (/^bash(\.exe)?$/i.test(base)) return 'Bash'
  if (/^wsl(\.exe)?$/i.test(base)) return 'WSL'
  if (/[/\\]/.test(name)) return base.replace(/\.exe$/i, '')

  return name.length > 36 ? `${name.slice(0, 33)}…` : name
}

const GENERIC_SHELL_LABELS = new Set([
  'PowerShell',
  'PowerShell 7',
  '命令提示符',
  'Bash',
  'WSL',
])

/**
 * PowerShell/ConPTY often emit OSC titles like `powershell` on startup.
 * Those must not overwrite intentional tab labels such as「终端 1」or「OpenCode」.
 */
export function isGenericShellOscTitle(title: string): boolean {
  const cleaned = title.trim()
  if (!cleaned) return true
  if (/^(administrator:\s*)?windows\s*powershell(\s+\d+(\.\d+)*)?$/i.test(cleaned)) {
    return true
  }
  if (/^(powershell|pwsh|cmd|bash|wsl|sh|zsh|fish)(\.exe)?$/i.test(cleaned)) {
    return true
  }
  return GENERIC_SHELL_LABELS.has(shortenTerminalLabel(cleaned))
}

/**
 * Whether an OSC window title should rename the tab.
 * Keeps run-config labels fixed; blocks generic shell/ConPTY noise; allows
 * cwd / app titles (e.g. OpenCode, `npm run dev`, folder names).
 */
export function shouldApplyOscTabTitle(
  tab: { shellKind?: string } | null | undefined,
  title: string,
): boolean {
  if (!tab || !title.trim()) return false
  if (isGenericShellOscTitle(title)) return false
  // Run-config / script tasks keep their fixed task name.
  if (tab.shellKind && tab.shellKind !== 'interactive') return false
  return true
}

export function formatTerminalName(name: string) {
  return formatTerminalNumber(name) ?? shortenTerminalLabel(name)
}

/** Pick a readable tab name when creating a terminal from profile settings. */
export function resolveNewTerminalName(
  profileName: string,
  command: string,
  nextNumber: number,
  defaultProfileLabel = '普通终端',
  /** When the default profile has no command, prefer the shell display name. */
  shellLabel?: string,
): string {
  const cmd = command.trim()
  const name = profileName.trim()

  if (name && name !== defaultProfileLabel) return name

  if (cmd) {
    const fromCommand = shortenTerminalLabel(cmd)
    if (fromCommand) return fromCommand
  }

  const shell = shellLabel?.trim()
  if (shell) return shell

  return `终端 ${nextNumber}`
}

/** Avoid duplicate tab labels within the same project. */
export function disambiguateTerminalName(base: string, existingNames: string[]): string {
  if (!existingNames.includes(base)) return base
  let index = 2
  while (existingNames.includes(`${base} (${index})`)) index++
  return `${base} (${index})`
}

/** Short label for toasts and UI when tab name is a shell path or long string. */
export function terminalDisplayLabel(name: string): string {
  return formatTerminalName(name)
}
