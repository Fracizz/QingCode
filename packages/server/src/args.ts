export type ServerCommand = 'version' | 'ensure' | 'daemon' | 'connect'

export interface CliArgs {
  command: ServerCommand
  stateDir?: string
  replace: boolean
  stdio: boolean
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

const COMMANDS: readonly string[] = ['version', 'ensure', 'daemon', 'connect']
const STATE_DIR_FLAG = '--state-dir'

export function parseArgs(argv: readonly string[]): CliArgs {
  const [head, ...rest] = argv
  if (!head || !COMMANDS.includes(head)) {
    throw new CliError(`未知命令: ${head ?? '(空)'}`)
  }
  const command = head as ServerCommand

  let stateDir: string | undefined
  let replace = false
  let stdio = false

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) continue

    if (arg === '--replace') {
      if (command !== 'ensure') throw new CliError('--replace 只能用于 ensure')
      replace = true
      continue
    }
    if (arg === '--stdio') {
      if (command !== 'connect') throw new CliError('--stdio 只能用于 connect')
      stdio = true
      continue
    }
    if (arg === STATE_DIR_FLAG || arg.startsWith(`${STATE_DIR_FLAG}=`)) {
      const value = arg === STATE_DIR_FLAG ? rest[++i] : arg.slice(STATE_DIR_FLAG.length + 1)
      // 空值或以 -- 开头说明参数被漏写，否则会把下一个开关当成目录。
      if (!value || value.startsWith('--')) throw new CliError(`${STATE_DIR_FLAG} 需要一个目录`)
      stateDir = value
      continue
    }
    throw new CliError(`未知参数: ${arg}`)
  }

  if (command === 'connect' && !stdio) throw new CliError('connect 需要 --stdio')
  return { ...(stateDir !== undefined ? { stateDir } : {}), command, replace, stdio }
}
