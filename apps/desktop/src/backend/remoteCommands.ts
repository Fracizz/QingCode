// 远端部署命令与输出解析：纯逻辑，不触碰网络/文件，便于单测覆盖转义与容错。

export interface RemoteProbe {
  os: string
  home: string
  nodePath: string
  nodeVersion: string
  sha256sumPath: string
}

export interface ServerManifest {
  version: string
  sha256: string
}

export interface EnsureResult {
  token: string
  version: string
  pid: number
  started: boolean
  endpoint: string
}

const PROBE_PREFIX = 'QN_'
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/** POSIX 单引号包裹，内部单引号用 '\'' 序列断开，避免远端命令注入。 */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function buildProbeCommand(): string {
  return [
    `printf 'QN_OS=%s\\n' "$(uname -s)"`,
    `printf 'QN_HOME=%s\\n' "$HOME"`,
    `printf 'QN_NODE=%s\\n' "$(command -v node || true)"`,
    `printf 'QN_NODE_VER=%s\\n' "$(node -v 2>/dev/null || true)"`,
    `printf 'QN_SHA256SUM=%s\\n' "$(command -v sha256sum || true)"`,
  ].join('; ')
}

export function nodeMajor(version: string): number {
  const match = /^v?(\d+)(?:\.\d+)*(?:[-+].*)?$/.exec(version.trim())
  return match?.[1] ? Number(match[1]) : 0
}

export function parseProbe(stdout: string): RemoteProbe {
  const fields = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(PROBE_PREFIX)) continue
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const key = line.slice(PROBE_PREFIX.length, separator)
    const value = line.slice(separator + 1)
    if (!fields.has(key)) fields.set(key, value)
  }
  const os = fields.get('OS') ?? ''
  const home = fields.get('HOME') ?? ''
  const nodePath = fields.get('NODE') ?? ''
  const nodeVersion = fields.get('NODE_VER') ?? ''
  const sha256sumPath = fields.get('SHA256SUM') ?? ''
  if (!home) throw new Error('无法读取远端 $HOME')
  if (!nodePath) throw new Error('远端需要 Node ≥ 18')
  if (nodeMajor(nodeVersion) < 18) throw new Error('远端需要 Node ≥ 18')
  if (!sha256sumPath) throw new Error('远端缺少 sha256sum')
  if (/^(mingw|msys|cygwin|windows)/i.test(os) || /^windows/i.test(os)) {
    throw new Error('远端需要 POSIX 主机')
  }
  return { os, home, nodePath, nodeVersion, sha256sumPath }
}

export function serverInstallPath(home: string, version: string, sha256: string): string {
  const root = home.replace(/\/+$/, '')
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${root}/.qingcode-next/server/bin/${safeVersion}-${sha256.slice(0, 12)}/qn-server.cjs`
}

export function parentPosixPath(file: string): string {
  const index = file.lastIndexOf('/')
  return index > 0 ? file.slice(0, index) : '/'
}

export function parseManifest(raw: unknown): ServerManifest {
  if (!isRecord(raw) || typeof raw.version !== 'string' || typeof raw.sha256 !== 'string' ||
      !SHA256_PATTERN.test(raw.sha256)) {
    throw new Error('server 包清单无效')
  }
  return { version: raw.version, sha256: raw.sha256 }
}

export function buildShaCommand(sha256sumPath: string, file: string): string {
  return `${posixQuote(sha256sumPath)} ${posixQuote(file)} 2>/dev/null || true`
}

export function buildMkdirCommand(dir: string): string {
  return `mkdir -p ${posixQuote(dir)} && chmod 700 ${posixQuote(dir)}`
}

export function buildUploadCommand(tmp: string, dest: string): string {
  return `chmod 600 ${posixQuote(tmp)} && mv -f ${posixQuote(tmp)} ${posixQuote(dest)}`
}

export function buildEnsureCommand(nodePath: string, script: string): string {
  return `${posixQuote(nodePath)} ${posixQuote(script)} ensure --replace`
}

export function buildConnectCommand(nodePath: string, script: string): string {
  return `${posixQuote(nodePath)} ${posixQuote(script)} connect --stdio`
}

/** sha256sum 输出第一行形如 "<hash>  <file>"；文件不存在/工具缺失都视为未命中。 */
export function parseRemoteSha(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s/i.exec(line.trimStart())
    if (match?.[1]) return match[1].toLowerCase()
  }
  return null
}

/** ensure 的 stdout 含 token，解析失败时不能把原文写进错误信息或日志。 */
export function parseEnsureResult(stdout: string): EnsureResult {
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const { token, version, pid, started, endpoint } = parsed
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) continue
    if (typeof endpoint !== 'string' || endpoint.length === 0) continue
    return {
      token,
      version: typeof version === 'string' ? version : '',
      pid: typeof pid === 'number' ? pid : 0,
      started: started === true,
      endpoint,
    }
  }
  throw new Error('无法解析远端 daemon 的启动结果')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 远端 stderr / spawn 输出可能夹带 token，落日志前统一打码。 */
export function redactToken(text: string): string {
  return text.replace(/[0-9a-f]{64}/gi, '***').slice(0, 2048).trim()
}
