/** Host shell used by terminal profiles (not run-config script kinds). */

export type TerminalShellId = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'wsl' | 'bash' | 'zsh'

export type TerminalHostPlatform = 'win' | 'unix'

export function detectTerminalHostPlatform(): TerminalHostPlatform {
  if (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)) {
    return 'win'
  }
  return 'unix'
}

const ALL_SHELLS: TerminalShellId[] = ['auto', 'powershell', 'pwsh', 'cmd', 'wsl', 'bash', 'zsh']

/** Shells offered in settings for the current OS. */
export function availableTerminalShells(
  platform: TerminalHostPlatform = detectTerminalHostPlatform(),
): TerminalShellId[] {
  if (platform === 'win') {
    // Default-first order for the global picker.
    return ['auto', 'pwsh', 'powershell', 'cmd', 'wsl']
  }
  return ['zsh', 'bash', 'pwsh']
}

/** Platform built-in default when the user has not chosen a global shell. */
export function defaultTerminalShell(
  platform: TerminalHostPlatform = detectTerminalHostPlatform(),
): TerminalShellId {
  return platform === 'win' ? 'auto' : 'zsh'
}

/** Chinese source keys for i18n (`translate` / locale messages). */
/**
 * Shell id used for a new interactive tab label before PTY spawn resolves `auto`.
 * Does not affect spawn selection — only naming / post-spawn rename eligibility.
 */
export function effectiveShellForTerminalName(
  profileShell: TerminalShellId,
  globalDefaultShell: TerminalShellId,
  platform: TerminalHostPlatform = detectTerminalHostPlatform(),
): TerminalShellId {
  if (profileShell !== 'auto') return profileShell
  if (globalDefaultShell !== 'auto') return globalDefaultShell
  return platform === 'win' ? 'pwsh' : 'zsh'
}

export function terminalShellLabelKey(shell: TerminalShellId): string {
  switch (shell) {
    case 'auto':
      return '自动选择'
    case 'powershell':
      return 'Windows PowerShell'
    case 'pwsh':
      return 'PowerShell 7'
    case 'cmd':
      return '命令提示符'
    case 'wsl':
      return 'WSL'
    case 'bash':
      return 'Bash'
    case 'zsh':
      return 'Zsh'
  }
}

export function isTerminalShellId(value: unknown): value is TerminalShellId {
  return typeof value === 'string' && (ALL_SHELLS as string[]).includes(value)
}

/**
 * Normalize persisted / UI values. Unknown or platform-invalid ids fall back
 * to the platform default.
 */
export function normalizeTerminalShell(
  value: unknown,
  platform: TerminalHostPlatform = detectTerminalHostPlatform(),
): TerminalShellId {
  const available = availableTerminalShells(platform)
  if (isTerminalShellId(value) && available.includes(value)) {
    return value
  }
  return defaultTerminalShell(platform)
}
