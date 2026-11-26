import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ServerPaths {
  stateDir: string
  runDir: string
  tokenFile: string
  daemonJson: string
  daemonLog: string
  /** POSIX 是 unix socket 路径，Windows 是命名管道名。 */
  endpoint: string
  /** 仅 POSIX：陈旧 socket 文件需要删除后重新监听。 */
  socketFile?: string
  customStateDir: boolean
}

export interface PathOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homedir?: string
  username?: string
}

export interface DaemonInfo {
  pid: number
  version: string
  startedAt: number
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export function defaultStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.win32.join(homedir, 'AppData', 'Local')
    return path.win32.join(localAppData, 'qingcode-next', 'server')
  }
  return path.posix.join(env.HOME ?? homedir, '.qingcode-next', 'server')
}

/** 本机 backend 直接用的管道名（默认 state dir），规则必须与之保持一致。 */
export function localPipeName(username: string): string {
  return `\\\\.\\pipe\\qingcode-next-${sanitizeUser(username)}`
}

function sanitizeUser(username: string): string {
  return username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user'
}

function resolveStateDir(stateDir: string, isWindows: boolean): string {
  return isWindows ? path.win32.resolve(stateDir) : path.posix.resolve(stateDir)
}

export function resolvePaths(stateDir?: string, opts: PathOptions = {}): ServerPaths {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const homedir = opts.homedir ?? os.homedir()
  const isWindows = platform === 'win32'

  const fallback = defaultStateDir(env, platform, homedir)
  const resolved = stateDir ? resolveStateDir(stateDir, isWindows) : fallback
  // 明确传入默认目录时仍按默认处理，避免出现两个不同的管道名。
  const normalize = (s: string): string => (isWindows ? s.toLowerCase() : s)
  const customStateDir = stateDir !== undefined && normalize(resolved) !== normalize(fallback)
  const join = isWindows ? path.win32.join : path.posix.join
  const runDir = join(resolved, 'run')
  const user = sanitizeUser(opts.username ?? env.USERNAME ?? env.USER ?? 'user')

  let endpoint: string
  let socketFile: string | undefined
  if (isWindows) {
    endpoint = customStateDir
      ? `${localPipeName(user)}-${createHash('sha256').update(normalize(resolved)).digest('hex').slice(0, 8)}`
      : localPipeName(user)
  } else {
    endpoint = path.posix.join(runDir, 'daemon.sock')
    socketFile = endpoint
  }

  return {
    stateDir: resolved,
    runDir,
    tokenFile: join(runDir, 'token'),
    daemonJson: join(runDir, 'daemon.json'),
    daemonLog: join(runDir, 'daemon.log'),
    endpoint,
    ...(socketFile !== undefined ? { socketFile } : {}),
    customStateDir,
  }
}

export function ensureRunDir(paths: ServerPaths, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') fs.chmodSync(paths.runDir, 0o700)
}

export function readToken(paths: ServerPaths): string | null {
  try {
    const value = fs.readFileSync(paths.tokenFile, 'utf8').trim()
    return TOKEN_PATTERN.test(value) ? value : null
  } catch {
    return null
  }
}

/** 单实例用 token 文件本身做创建竞争：输家重读赢家写的 token。 */
export function readOrCreateToken(paths: ServerPaths, platform: NodeJS.Platform = process.platform): string {
  const existing = readToken(paths)
  if (existing) return existing

  const token = randomBytes(32).toString('hex')
  // 文件已存在但内容损坏时覆盖重建；不存在时用 wx 做单实例创建竞争。
  const flag = fs.existsSync(paths.tokenFile) ? 'w' : 'wx'
  try {
    fs.writeFileSync(paths.tokenFile, `${token}\n`, { flag, mode: 0o600 })
    if (platform !== 'win32') fs.chmodSync(paths.tokenFile, 0o600)
    return token
  } catch (cause) {
    const winner = readToken(paths)
    if (winner) return winner
    throw cause
  }
}

export function readDaemonJson(paths: ServerPaths): DaemonInfo | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(paths.daemonJson, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const info = raw as Partial<DaemonInfo>
    if (typeof info.pid !== 'number' || typeof info.version !== 'string' || typeof info.startedAt !== 'number') {
      return null
    }
    return { pid: info.pid, version: info.version, startedAt: info.startedAt }
  } catch {
    return null
  }
}

export function writeDaemonJson(paths: ServerPaths, info: DaemonInfo): void {
  const tmp = `${paths.daemonJson}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`, 'utf8')
  fs.renameSync(tmp, paths.daemonJson)
}

export function removeDaemonJson(paths: ServerPaths): void {
  try {
    fs.rmSync(paths.daemonJson, { force: true })
  } catch {
    // 退出清理失败不影响 daemon 本身。
  }
}
