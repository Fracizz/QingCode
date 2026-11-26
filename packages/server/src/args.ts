export type ServerCommand = 'version' | 'ensure' | 'daemon' | 'connect' | 'serve' | 'direct'
export type DirectAction = 'enable' | 'disable' | 'grant' | 'revoke' | 'status'

export interface CliArgs {
  command: ServerCommand
  stateDir?: string
  replace: boolean
  stdio: boolean
  /** serve / direct enable：监听地址 host:port 或 port */
  listen?: string
  /** direct 子命令 */
  action?: DirectAction
  /** direct enable / serve：允许公网来源 */
  allowPublic?: boolean
  /** direct grant / serve：授权名称（一般是客户端电脑名） */
  name?: string
  /** direct grant / serve：写进连接码的地址（可多次），缺省自动列出局域网 IPv4 */
  hosts?: string[]
  /** direct revoke：授权 id */
  id?: string
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

const COMMANDS: readonly string[] = ['version', 'ensure', 'daemon', 'connect', 'serve', 'direct']
const DIRECT_ACTIONS: readonly string[] = ['enable', 'disable', 'grant', 'revoke', 'status']
const STATE_DIR_FLAG = '--state-dir'

/** 每个带值开关允许出现在哪些命令（direct 再按子命令细分）。 */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  '--listen': ['serve', 'direct:enable'],
  '--name': ['serve', 'direct:grant'],
  '--host': ['serve', 'direct:grant'],
  '--id': ['direct:revoke'],
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const [head, ...tail] = argv
  if (!head || !COMMANDS.includes(head)) {
    throw new CliError(`未知命令: ${head ?? '(空)'}`)
  }
  const command = head as ServerCommand
  let rest = tail
  let action: DirectAction | undefined
  if (command === 'direct') {
    const sub = rest[0]
    if (!sub || !DIRECT_ACTIONS.includes(sub)) throw new CliError(`direct 需要子命令: ${DIRECT_ACTIONS.join(' | ')}`)
    action = sub as DirectAction
    rest = rest.slice(1)
  }
  const scope = action ? `direct:${action}` : command

  let stateDir: string | undefined
  let replace = false
  let stdio = false
  let allowPublic = false
  let listen: string | undefined
  let name: string | undefined
  let id: string | undefined
  const hosts: string[] = []

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
    if (arg === '--allow-public') {
      if (scope !== 'serve' && scope !== 'direct:enable') throw new CliError('--allow-public 只能用于 serve / direct enable')
      allowPublic = true
      continue
    }
    const flag = Object.keys(VALUE_FLAGS).find((f) => arg === f || arg.startsWith(`${f}=`))
    if (flag) {
      if (!VALUE_FLAGS[flag]?.includes(scope)) throw new CliError(`${flag} 不能用于 ${scope.replace(':', ' ')}`)
      const value = arg === flag ? rest[++i] : arg.slice(flag.length + 1)
      if (!value || value.startsWith('--')) throw new CliError(`${flag} 需要一个值`)
      if (flag === '--listen') listen = value
      else if (flag === '--name') name = value
      else if (flag === '--id') id = value
      else hosts.push(value)
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
  if ((scope === 'serve' || scope === 'direct:enable') && listen === undefined) {
    throw new CliError(`${scope.replace(':', ' ')} 需要 --listen`)
  }
  if (scope === 'direct:revoke' && id === undefined) throw new CliError('direct revoke 需要 --id')
  return {
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(listen !== undefined ? { listen } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(allowPublic ? { allowPublic } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(hosts.length > 0 ? { hosts } : {}),
    ...(id !== undefined ? { id } : {}),
    command,
    replace,
    stdio,
  }
}
