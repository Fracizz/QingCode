// 纯逻辑：term.* 参数校验、环境变量组装、后端选择、控制通道编解码。不碰任何 IO。
import path from 'node:path'
import type { WorkspaceErrorCode } from '@qn/protocol'
import type { TermBackend, TermBackendPreference, TermErrorCode } from './types'
import { WorkspaceError } from '../workspace/registry'
import { fromWindowsSftpPath } from '../workspace/paths'

/** term.write 单次上限（原始字节）。 */
export const MAX_WRITE_BYTES = 1024 * 1024
/** 写入队列（尚未被 PTY 宿主读走的字节）超过它就拒绝新的写入。 */
export const MAX_WRITE_QUEUE_BYTES = 4 * 1024 * 1024
/** 快照上限（原始字节）。 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
const MAX_SIZE = 1000
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 4096
const MAX_ENV_ENTRIES = 256
const MAX_ENV_VALUE = 32 * 1024
const TERM_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// 动态链接器/解释器注入与 daemon 自身配置：客户端不能借终端 env 改变 PTY 宿主的行为。
const BLOCKED_ENV_RE = /^(LD_|DYLD_|PYTHON|QN_|QINGCODE)/i
// daemon 自身配置不泄漏给用户 shell；其余继承的变量（含 LD_LIBRARY_PATH 等）原样保留。
const DAEMON_ENV_RE = /^(QN_|QINGCODE|ELECTRON_RUN_AS_NODE$)/i
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export function termError(code: TermErrorCode | WorkspaceErrorCode, message: string): WorkspaceError {
  return new WorkspaceError(code, message)
}

function paramsError(message: string): WorkspaceError {
  return new WorkspaceError('params', message)
}

function hasNul(text: string): boolean {
  return text.includes('\0')
}

export function parseTermId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !TERM_ID_RE.test(value)) {
    throw paramsError(`${method} 需要合法的 termId（1–64 位字母、数字或 _ . : -）`)
  }
  return value
}

/** 0、负数、NaN 都按缺省处理：无 TTY 时 getWindowSize() 会给出 0×0（spike §2.3-6）。 */
export function clampSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(MAX_SIZE, Math.floor(value))
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw paramsError(`${field} 必须是最多 ${MAX_ARGS} 项的字符串数组`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length > MAX_ARG_LENGTH || hasNul(item)) {
      throw paramsError(`${field} 只能包含不含 NUL 的字符串`)
    }
    return item
  })
}

export function parseEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw paramsError('env 必须是字符串键值对象')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENV_ENTRIES) throw paramsError(`env 最多 ${MAX_ENV_ENTRIES} 项`)
  const out: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!ENV_KEY_RE.test(key)) throw paramsError(`env 变量名不合法: ${key}`)
    if (BLOCKED_ENV_RE.test(key)) throw paramsError(`env 不允许设置 ${key}`)
    // 只报变量名，不回显值：值里可能是 token。
    if (typeof raw !== 'string' || raw.length > MAX_ENV_VALUE || hasNul(raw)) {
      throw paramsError(`env.${key} 必须是不含 NUL 的字符串`)
    }
    out[key] = raw
  }
  return out
}

const PREFERENCES: readonly TermBackendPreference[] = ['auto', 'python', 'script', 'conpty']

export interface OpenRequest {
  termId?: string
  cwd: string
  shell?: string
  args: string[]
  cols: number
  rows: number
  env: Record<string, string>
  backend: TermBackendPreference
}

export function parseOpenParams(
  p: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): OpenRequest {
  const termId = p.termId === undefined ? undefined : parseTermId(p.termId, 'term.open')
  // 项目根可能是 SFTP 风格 `/D:/code/repo`，Windows 上需转成盘符路径，否则 stat 会失败
  const cwd = platform === 'win32' && typeof p.cwd === 'string' ? fromWindowsSftpPath(p.cwd) : p.cwd
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (typeof cwd !== 'string' || cwd.length === 0 || hasNul(cwd) || !pathApi.isAbsolute(cwd)) {
    throw paramsError('term.open 需要绝对路径 cwd')
  }
  let shell: string | undefined
  if (p.shell !== undefined) {
    if (typeof p.shell !== 'string' || p.shell.length === 0 || p.shell.length > MAX_ARG_LENGTH || hasNul(p.shell)) {
      throw paramsError('shell 必须是非空字符串')
    }
    shell = p.shell
  }
  const backend = p.backend ?? 'auto'
  if (typeof backend !== 'string' || !PREFERENCES.includes(backend as TermBackendPreference)) {
    throw paramsError(`backend 只能是 ${PREFERENCES.join('、')}`)
  }
  return {
    ...(termId !== undefined ? { termId } : {}),
    cwd: pathApi.normalize(cwd),
    ...(shell !== undefined ? { shell } : {}),
    args: parseStringArray(p.args, 'args'),
    cols: clampSize(p.cols, DEFAULT_COLS),
    rows: clampSize(p.rows, DEFAULT_ROWS),
    env: parseEnv(p.env),
    backend: backend as TermBackendPreference,
  }
}

/** 由 base64 长度推算原始字节数，避免先解码 1 MiB 以上的大串再判断超限。 */
export function base64DecodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

export function parseBase64(value: unknown, field: string, maxBytes: number, tooLarge: TermErrorCode | 'too_large'): Buffer {
  if (typeof value !== 'string') throw paramsError(`${field} 必须是 base64 字符串`)
  if (base64DecodedLength(value) > maxBytes) {
    throw termError(tooLarge, `${field} 超过 ${maxBytes} 字节上限`)
  }
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) throw paramsError(`${field} 不是合法的 base64`)
  return Buffer.from(value, 'base64')
}

export function parseWriteParams(p: Record<string, unknown>): { termId: string; data: Buffer } {
  const termId = parseTermId(p.termId, 'term.write')
  return { termId, data: parseBase64(p.data, 'data', MAX_WRITE_BYTES, 'term_input_too_large') }
}

export function parseResizeParams(p: Record<string, unknown>): { termId: string; cols: number; rows: number } {
  const termId = parseTermId(p.termId, 'term.resize')
  if (typeof p.cols !== 'number' || typeof p.rows !== 'number' || !(p.cols >= 1) || !(p.rows >= 1)) {
    throw paramsError('term.resize 需要正数 cols/rows')
  }
  return { termId, cols: clampSize(p.cols, DEFAULT_COLS), rows: clampSize(p.rows, DEFAULT_ROWS) }
}

export function parseAttachParams(p: Record<string, unknown>): { termId: string; sinceSeq: number } {
  const termId = parseTermId(p.termId, 'term.attach')
  const since = p.sinceSeq ?? 0
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) {
    throw paramsError('term.attach 的 sinceSeq 必须是非负数')
  }
  return { termId, sinceSeq: Math.floor(since) }
}

export function parseSnapshotParams(p: Record<string, unknown>): {
  termId: string
  seq: number
  data: string
  cols: number
  rows: number
} {
  const termId = parseTermId(p.termId, 'term.snapshot')
  if (typeof p.seq !== 'number' || !Number.isInteger(p.seq) || p.seq < 0) {
    throw paramsError('term.snapshot 需要非负整数 seq')
  }
  const data = parseBase64(p.data, 'data', MAX_SNAPSHOT_BYTES, 'too_large').toString('base64')
  return {
    termId,
    seq: p.seq,
    data,
    cols: clampSize(p.cols, DEFAULT_COLS),
    rows: clampSize(p.rows, DEFAULT_ROWS),
  }
}

export function defaultShell(env: NodeJS.ProcessEnv, platform = process.platform): string {
  if (platform === 'win32') {
    const command = env.ComSpec ?? env.COMSPEC
    return command && path.win32.isAbsolute(command) && !hasNul(command) ? command : 'cmd.exe'
  }
  const shell = env.SHELL
  return typeof shell === 'string' && shell.startsWith('/') && !hasNul(shell) ? shell : '/bin/sh'
}

/** 子进程环境：daemon 环境 + 客户端 env，再补终端必需变量。 */
export function buildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  cols: number,
  rows: number,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    // ELECTRON_RUN_AS_NODE 会让终端里启动的 electron 程序退化成 node。
    if (typeof value === 'string' && !DAEMON_ENV_RE.test(key)) {
      out[key] = value
    }
  }
  Object.assign(out, extra)
  // daemon 由 ssh exec 拉起时常没有 TERM / 是 dumb，全屏程序会退化。
  if (!out.TERM || out.TERM === 'dumb') out.TERM = 'xterm-256color'
  out.COLORTERM ??= 'truecolor'
  out.COLUMNS = String(cols)
  out.LINES = String(rows)
  return out
}

export interface ProbeResult {
  ok: boolean
  version: string
  detail: string
}

export interface Capabilities {
  posix: boolean
  python3: ProbeResult
  script: ProbeResult
  /** T31 在 Windows 上接入的原生后端（ConPTY） */
  native?: { ok: boolean; backend: TermBackend; detail: string }
}

export type BackendChoice = { ok: true; backend: TermBackend } | { ok: false; message: string }

export function chooseBackend(caps: Capabilities, preferred: TermBackendPreference = 'auto'): BackendChoice {
  const native = caps.native?.ok === true ? caps.native.backend : null
  const python = caps.posix && caps.python3.ok
  const script = caps.posix && caps.script.ok
  switch (preferred) {
    case 'python':
      return python
        ? { ok: true, backend: 'python' }
        : { ok: false, message: `python3 PTY 桥不可用：${caps.python3.detail || '需要 POSIX + python3 标准库 pty'}` }
    case 'script':
      return script
        ? { ok: true, backend: 'script' }
        : { ok: false, message: `script 兜底不可用：${caps.script.detail || '需要 util-linux script'}` }
    case 'conpty':
      return native === 'conpty'
        ? { ok: true, backend: 'conpty' }
        : { ok: false, message: 'ConPTY 后端未接入（Windows 终端由后续版本提供）' }
    default:
      if (native) return { ok: true, backend: native }
      if (python) return { ok: true, backend: 'python' }
      if (script) return { ok: true, backend: 'script' }
      return {
        ok: false,
        message: caps.posix
          ? '目标上没有可用的终端后端：需要 python3（标准库 pty）或 util-linux script'
          : 'Windows 本机终端需要 ConPTY 后端，当前版本尚未提供',
      }
  }
}

/** python3 探测输出里可能夹带告警，只取第一个 { 到最后一个 } 解析。 */
export function parsePythonProbe(stdout: string): ProbeResult {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, version: '', detail: 'python3 探测无输出' }
  try {
    const value = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    const ok = value.ok === true && value.pty === true
    return {
      ok,
      version: typeof value.version === 'string' ? value.version : '',
      detail: ok ? '' : 'python3 缺少 pty.fork 或 TIOCSWINSZ',
    }
  } catch {
    return { ok: false, version: '', detail: 'python3 探测输出无效' }
  }
}

/** BSD/macOS 的 script 缺 --return/--flush 等长选项，判为不可用。 */
export function parseScriptProbe(versionText: string, helpText: string): ProbeResult {
  const version = versionText.trim()
  const ok = ['--return', '--flush', '--command', '--quiet'].every((flag) => helpText.includes(flag))
  return { ok, version, detail: ok ? '' : 'script 缺少 -q/-f/-e/-c 必要选项（需要 util-linux 版）' }
}

/** `script -c` 会再经一次 sh -c 解析，参数必须逐个单引号转义。 */
export function posixQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

export function scriptCommand(shell: string, args: string[], cols: number, rows: number): string {
  const quoted = [shell, ...args].map(posixQuote).join(' ')
  // script 不给 pty 设尺寸，只能在 exec 之前 stty 一次（运行中无法再改）。
  return `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${quoted}`
}

export function encodeControlLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`
}

/** 增量解析 fd 3 上的 JSON 行；半行、坏行都不能让宿主挂掉。 */
export class ControlLineDecoder {
  private buffer = ''

  push(chunk: string | Uint8Array): Array<Record<string, unknown>> {
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const out: Array<Record<string, unknown>> = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        try {
          const value: unknown = JSON.parse(line)
          if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>)
        } catch {
          // 坏行丢弃，数据通道不受影响。
        }
      }
      newline = this.buffer.indexOf('\n')
    }
    // 防御：宿主异常时不让半行无限增长。
    if (this.buffer.length > 64 * 1024) this.buffer = ''
    return out
  }
}

/** 信号统一成名字：Python 桥给编号，Node 给名字。 */
export function normalizeSignal(
  value: unknown,
  table: Readonly<Record<string, number>> = {},
): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    for (const [name, num] of Object.entries(table)) if (num === value) return name
    return `SIG${value}`
  }
  return null
}

export function generateTermId(random: () => string): string {
  return `t-${random()}`
}
