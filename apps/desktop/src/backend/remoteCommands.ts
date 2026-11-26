// 远端部署命令与输出解析：纯逻辑，不触碰网络/文件，便于单测覆盖转义与容错。

export interface RemoteProbe {
  os: string
  home: string
  arch: string
  nodePath: string
  nodeVersion: string
  sha256sumPath: string
}

export interface ServerManifest {
  version: string
  sha256: string
}

export interface RuntimeManifest {
  version: string
  targets: Record<string, { file: string; sha256: string }>
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
    `printf 'QN_ARCH=%s\\n' "$(uname -m)"`,
    `printf 'QN_NODE=%s\\n' "$(command -v node || true)"`,
    `printf 'QN_NODE_VER=%s\\n' "$(node -v 2>/dev/null || true)"`,
    `printf 'QN_SHA256SUM=%s\\n' "$(command -v sha256sum || { command -v shasum >/dev/null && echo 'shasum -a 256'; } || true)"`,
  ].join('; ')
}

export function nodeMajor(version: string): number {
  const match = /^v?(\d+)(?:\.\d+)*(?:[-+].*)?$/.exec(version.trim())
  return match?.[1] ? Number(match[1]) : 0
}

function probeFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(PROBE_PREFIX)) continue
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const key = line.slice(PROBE_PREFIX.length, separator)
    const value = line.slice(separator + 1)
    if (!fields.has(key)) fields.set(key, value)
  }
  return fields
}

export function parseProbe(stdout: string): RemoteProbe {
  const fields = probeFields(stdout)
  const os = fields.get('OS') ?? ''
  const home = fields.get('HOME') ?? ''
  const arch = fields.get('ARCH') ?? ''
  let nodePath = fields.get('NODE') ?? ''
  let nodeVersion = fields.get('NODE_VER') ?? ''
  const sha256sumPath = fields.get('SHA256SUM') ?? ''
  if (!home) throw new Error('无法读取远端 $HOME')
  // 缺 node / 版本过低时留空，由 deployServer 决定推送内置运行时，探测阶段不拒绝。
  if (!nodePath || nodeMajor(nodeVersion) < 18) {
    nodePath = ''
    nodeVersion = ''
  }
  if (!sha256sumPath) throw new Error('远端缺少 sha256sum')
  if (/^(mingw|msys|cygwin|windows)/i.test(os) || /^windows/i.test(os)) {
    throw new Error('远端需要 POSIX 主机')
  }
  return { os, home, arch, nodePath, nodeVersion, sha256sumPath }
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
  // macOS 回退的 "shasum -a 256" 带参数，整串引用会被当成单个可执行文件名。
  const tool = sha256sumPath.includes(' ')
    ? sha256sumPath.split(' ').filter(Boolean).map(posixQuote).join(' ')
    : posixQuote(sha256sumPath)
  return `${tool} ${posixQuote(file)} 2>/dev/null || true`
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

/** 任意 server 子命令（direct enable/grant 等）；参数逐个引用，不经 shell 拼接。 */
export function buildServerCommand(nodePath: string, script: string, args: readonly string[]): string {
  return [nodePath, script, ...args].map(posixQuote).join(' ')
}

/** server 子命令输出一行 JSON；可能夹带连接码/token，解析失败时不回显原文。 */
export function parseJsonLine(stdout: string): Record<string, unknown> {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text) as unknown
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // 继续找上一行。
    }
  }
  throw new Error('远端 server 输出无法解析')
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

// ---------- 内置 Node 运行时 ----------

/** 远端无 Node 时按平台挑选内置二进制；不支持的平台返回 null。 */
export function runtimeTargetKey(os: string, arch: string): string | null {
  switch (os) {
    case 'Linux':
      if (arch === 'x86_64' || arch === 'amd64') return 'linux-x64'
      if (arch === 'aarch64' || arch === 'arm64') return 'linux-arm64'
      return null
    case 'Darwin':
      if (arch === 'x86_64') return 'darwin-x64'
      if (arch === 'arm64' || arch === 'aarch64') return 'darwin-arm64'
      return null
    default:
      return null
  }
}

export function parseRuntimeManifest(raw: unknown): RuntimeManifest {
  if (!isRecord(raw) || typeof raw.version !== 'string' || !isRecord(raw.targets)) {
    throw new Error('内置 Node 清单无效')
  }
  const targets: RuntimeManifest['targets'] = {}
  for (const [key, value] of Object.entries(raw.targets)) {
    if (!isRecord(value) || typeof value.file !== 'string' || typeof value.sha256 !== 'string' ||
        !SHA256_PATTERN.test(value.sha256)) {
      throw new Error('内置 Node 清单无效')
    }
    const file = value.file
    // 拒绝路径穿越与绝对路径，避免读到 resources 目录之外的文件。
    if (!file || file.includes('..') || file.startsWith('/') || file.startsWith('\\') ||
        /^[A-Za-z]:/.test(file)) {
      throw new Error('内置 Node 清单无效')
    }
    targets[key] = { file, sha256: value.sha256 }
  }
  return { version: raw.version, targets }
}

export function runtimeInstallPath(home: string, sha256: string): string {
  return `${home}/.qingcode-next/runtimes/node-${sha256.slice(0, 16)}/bin/node`
}

export function buildRuntimeSelfTestCommand(nodePath: string): string {
  return `${posixQuote(nodePath)} -e 0 && echo QN_NODE_OK`
}

export function buildRuntimeInstallCommand(tmp: string, dest: string): string {
  return `chmod 755 ${posixQuote(tmp)} && mv -f ${posixQuote(tmp)} ${posixQuote(dest)}`
}

// ---------- Windows 远端 ----------
// 默认 shell 可能是 cmd、PowerShell 或 Git Bash，引号规则互不相同：
// 文件操作一律交给 node 执行，脚本以 base64url 传入，命令行里不出现任何需要按 shell 转义的字符。

function nodeEval(source: string): string {
  const encoded = Buffer.from(source, 'utf8').toString('base64url')
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`
}

/** 三种 shell 的双引号内仍会展开的字符直接拒绝，而不是尝试转义。 */
export function windowsQuote(value: string): string {
  if (/["%$`\r\n]/.test(value)) throw new Error('远端路径包含不支持的字符')
  return `"${value}"`
}

export function buildWindowsProbeCommand(): string {
  return nodeEval([
    "const os = require('os')",
    "console.log('QN_OS=' + process.platform)",
    "console.log('QN_HOME=' + os.homedir().split(String.fromCharCode(92)).join('/'))",
    "console.log('QN_ARCH=' + process.arch)",
    "console.log('QN_NODE_VER=' + process.version)",
  ].join('\n'))
}

/** POSIX 探测在 cmd / PowerShell 下没有输出，在 Git Bash 下 uname 为 MINGW*：两者都要改走 Windows 分支。 */
export function isPosixProbe(stdout: string): boolean {
  const os = probeFields(stdout).get('OS') ?? ''
  return /^[A-Za-z][\w.-]*$/.test(os) && !/^(mingw|msys|cygwin|windows)/i.test(os)
}

export function parseWindowsProbe(stdout: string): RemoteProbe {
  const fields = probeFields(stdout)
  const home = fields.get('HOME') ?? ''
  const nodeVersion = fields.get('NODE_VER') ?? ''
  if (fields.get('OS') !== 'win32') throw new Error('无法识别远端系统')
  if (!home) throw new Error('无法读取远端用户目录')
  if (nodeMajor(nodeVersion) < 18) throw new Error('远端需要 Node ≥ 18')
  return { os: 'Windows', home, arch: fields.get('ARCH') ?? '', nodePath: 'node', nodeVersion, sha256sumPath: '' }
}

export function buildWindowsMkdirCommand(dir: string): string {
  return nodeEval(`require('fs').mkdirSync(${JSON.stringify(dir)}, { recursive: true })`)
}

/** 输出格式与 sha256sum 一致，复用 parseRemoteSha；文件不存在时无输出。 */
export function buildWindowsShaCommand(file: string): string {
  return nodeEval([
    "const fs = require('fs')",
    `const file = ${JSON.stringify(file)}`,
    "if (fs.existsSync(file)) console.log(require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  qn')",
  ].join('\n'))
}

export function buildWindowsUploadCommand(tmp: string, dest: string): string {
  return nodeEval(`require('fs').renameSync(${JSON.stringify(tmp)}, ${JSON.stringify(dest)})`)
}

export function buildWindowsEnsureCommand(script: string): string {
  return `node ${windowsQuote(script)} ensure --replace`
}

export function buildWindowsConnectCommand(script: string): string {
  return `node ${windowsQuote(script)} connect --stdio`
}

export function buildWindowsServerCommand(script: string, args: readonly string[]): string {
  return ['node', windowsQuote(script), ...args.map(windowsQuote)].join(' ')
}

/** Win32-OpenSSH 的 sftp-server 用 /C:/... 表示盘符路径。 */
export function windowsSftpPath(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? `/${path}` : path
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
