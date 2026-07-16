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

export function formatTerminalName(name: string) {
  return formatTerminalNumber(name) ?? shortenTerminalLabel(name)
}

function isPathLike(value: string) {
  return /[/\\]/.test(value) || /^[a-zA-Z]:/.test(value)
}

/** Pick a readable tab name when creating a terminal from profile settings. */
export function resolveNewTerminalName(
  profileName: string,
  command: string,
  nextNumber: number,
  defaultProfileLabel = '普通终端'
): string {
  const cmd = command.trim()
  const name = profileName.trim()

  if (!cmd) return `终端 ${nextNumber}`

  if (name && name !== defaultProfileLabel && name !== cmd && !isPathLike(name)) {
    return name
  }

  const fromCommand = shortenTerminalLabel(cmd)
  if (fromCommand && fromCommand !== cmd) return fromCommand

  return `终端 ${nextNumber}`
}

/** Short label for toasts and UI when tab name is a shell path or long string. */
export function terminalDisplayLabel(name: string): string {
  return formatTerminalName(name)
}
