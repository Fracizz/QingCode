import os from 'node:os'
import path from 'node:path'
import { WorkspaceError } from '../registry'
import { normalizePathForCompare } from '../paths'

export interface RecordParams {
  [key: string]: unknown
}

export const MAX_UTF8_READ_BYTES = 2 * 1024 * 1024
export const MAX_BASE64_READ_BYTES = 10 * 1024 * 1024
export const BINARY_SAMPLE_BYTES = 8 * 1024
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
export const MAX_MATCH_TEXT = 300
export const DEFAULT_MAX_RESULTS = 500
export const MAX_MAX_RESULTS = 5000
export const MAX_WATCH_PATHS = 500
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.hg', '.svn'])

export function paramsError(message: string): never {
  throw new WorkspaceError('params', message)
}

/** POSIX 绝对的 /、Windows 盘符与 UNC 都算绝对路径；server 两种平台上都会跑。 */
export function isAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.startsWith('\\\\')
}

export function requireAbsolutePath(value: unknown, field = 'path'): string {
  if (!isAbsolutePath(value)) paramsError(`${field} 必须是绝对路径`)
  return value
}

export function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    paramsError(`${field} 必须是非空字符串`)
  }
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') paramsError(`${field} 必须是布尔值`)
  return value
}

function optionalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    paramsError(`${field} 必须是非负整数`)
  }
  return value
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    paramsError(`${field} 必须是非负数`)
  }
  return value
}

function optionalEncoding(value: unknown, field: string): 'utf8' | 'base64' | undefined {
  if (value === undefined) return undefined
  if (value !== 'utf8' && value !== 'base64') paramsError(`${field} 只能是 utf8 或 base64`)
  return value
}

function optionalSourceEncoding(value: unknown, field: string): 'utf16le' | 'utf16be' | undefined {
  if (value === undefined) return undefined
  if (value !== 'utf16le' && value !== 'utf16be') {
    paramsError(`${field} 只能是 utf16le 或 utf16be`)
  }
  return value
}

export interface ParsedRead {
  path: string
  offset: number
  length: number
  encoding?: 'utf8' | 'base64'
}

export function parseReadParams(p: RecordParams): ParsedRead {
  const filePath = requireAbsolutePath(p.path)
  const offset = optionalNonNegativeInt(p.offset, 'offset') ?? 0
  const encoding = optionalEncoding(p.encoding, 'encoding')
  const limit = encoding === 'base64' ? MAX_BASE64_READ_BYTES : MAX_UTF8_READ_BYTES
  const requested = optionalNonNegativeInt(p.length, 'length') ?? limit
  return {
    path: filePath,
    offset,
    length: Math.min(requested, limit),
    ...(encoding !== undefined ? { encoding } : {}),
  }
}

export interface ParsedWrite {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
  expectedMtimeMs?: number
  create: boolean
  bom?: boolean
  sourceEncoding?: 'utf16le' | 'utf16be'
}

export function parseWriteParams(p: RecordParams): ParsedWrite {
  const encoding = optionalEncoding(p.encoding, 'encoding')
  const expectedMtimeMs = optionalFiniteNumber(p.expectedMtimeMs, 'expectedMtimeMs')
  const bom = optionalBoolean(p.bom, 'bom')
  const sourceEncoding = optionalSourceEncoding(p.sourceEncoding, 'sourceEncoding')
  return {
    path: requireAbsolutePath(p.path),
    content: requireString(p.content, 'content', true),
    ...(encoding !== undefined ? { encoding } : {}),
    ...(expectedMtimeMs !== undefined ? { expectedMtimeMs } : {}),
    ...(bom !== undefined ? { bom } : {}),
    ...(sourceEncoding !== undefined ? { sourceEncoding } : {}),
    create: optionalBoolean(p.create, 'create') ?? true,
  }
}

export function parseRenameParams(p: RecordParams): { from: string; to: string } {
  return { from: requireAbsolutePath(p.from, 'from'), to: requireAbsolutePath(p.to, 'to') }
}

export function parseDeleteParams(p: RecordParams): { path: string; recursive: boolean } {
  return {
    path: requireAbsolutePath(p.path),
    recursive: optionalBoolean(p.recursive, 'recursive') ?? false,
  }
}

export interface ParsedSearch {
  root: string
  query: string
  mode: 'name' | 'content'
  glob?: string
  caseSensitive: boolean
  maxResults: number
}

export function parseSearchParams(p: RecordParams): ParsedSearch {
  const mode: 'name' | 'content' =
    p.mode === 'content' ? 'content' : p.mode === 'name' ? 'name' : paramsError('mode 只能是 name 或 content')
  const glob = p.glob === undefined ? undefined : requireString(p.glob, 'glob')
  const requested = optionalNonNegativeInt(p.maxResults, 'maxResults') ?? DEFAULT_MAX_RESULTS
  if (requested === 0) paramsError('maxResults 必须大于 0')
  return {
    root: requireAbsolutePath(p.root, 'root'),
    query: requireString(p.query, 'query'),
    mode,
    ...(glob !== undefined ? { glob } : {}),
    caseSensitive: optionalBoolean(p.caseSensitive, 'caseSensitive') ?? false,
    maxResults: Math.min(requested, MAX_MAX_RESULTS),
  }
}

export function parseWatchPaths(p: RecordParams): string[] {
  if (!Array.isArray(p.paths)) paramsError('paths 必须是数组')
  return (p.paths as unknown[]).map((item, index) => requireAbsolutePath(item, `paths[${index}]`))
}

export function parseSearchId(p: RecordParams): string {
  return requireString(p.searchId, 'searchId')
}

export function nodeErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Node 异常统一收敛成协议错误码，避免把内部堆栈/绝对路径细节暴露给客户端。 */
export function mapNodeError(err: unknown): WorkspaceError {
  if (err instanceof WorkspaceError) return err
  const message = err instanceof Error ? err.message : String(err)
  switch (nodeErrorCode(err)) {
    case 'ENOENT':
      return new WorkspaceError('not_found', message)
    case 'EEXIST':
      return new WorkspaceError('exists', message)
    case 'ENOTEMPTY':
      return new WorkspaceError('not_empty', message)
    case 'EACCES':
    case 'EPERM':
      return new WorkspaceError('permission', message)
    default:
      return new WorkspaceError('internal', message)
  }
}

/** 根目录与用户主目录不允许删除；Windows 还要覆盖盘符根、UNC 共享根与长路径写法。 */
export function isProtectedPath(
  value: string,
  home: string = os.homedir(),
  platform: string = process.platform,
): boolean {
  const target = normalizePathForCompare(value, platform)
  const homeKey = normalizePathForCompare(home, platform)
  if (target === '' || target === homeKey) return true
  if (/^[a-z]:$/i.test(target)) return true
  return /^\/\/[^/]+\/[^/]+$/.test(target)
}

/** 抽样里出现 NUL 或大量非法 UTF-8 序列即视为二进制，避免把图片当文本返回。 */
export function looksBinary(sample: Uint8Array, limit = BINARY_SAMPLE_BYTES): boolean {
  const buf = Buffer.from(sample.buffer, sample.byteOffset, Math.min(sample.byteLength, limit))
  if (buf.length === 0) return false
  if (buf.includes(0)) return true
  const text = buf.toString('utf8')
  let replacements = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) replacements++
  }
  return replacements / Math.max(1, text.length) > 0.05
}

/** 返回可安全解码为 utf8 的字节数：末尾被截断的多字节字符整段回退。 */
export function utf8SafeLength(buf: Uint8Array): number {
  let i = 0
  while (i < buf.length) {
    const lead = buf[i]!
    let need = 1
    if (lead >= 0xc2 && lead <= 0xdf) need = 2
    else if (lead >= 0xe0 && lead <= 0xef) need = 3
    else if (lead >= 0xf0 && lead <= 0xf4) need = 4
    else {
      // ASCII、孤立续字节与非法首字节交给解码器替换，不影响后续边界。
      i++
      continue
    }
    if (i + need > buf.length) return i
    let complete = true
    for (let j = 1; j < need; j++) {
      const next = buf[i + j]!
      if (next < 0x80 || next > 0xbf) {
        complete = false
        break
      }
    }
    i += complete ? need : 1
  }
  return buf.length
}

export function truncateText(text: string, limit = MAX_MATCH_TEXT): string {
  const single = text.replace(/\r?\n$/, '')
  return single.length > limit ? single.slice(0, limit) : single
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/** 支持 *、?、**、[]；无斜杠的模式只匹配 basename（与编辑器 glob 习惯一致）。 */
export function matchGlob(relativePath: string, pattern: string, caseSensitive = false): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/')
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const hasSlash = normalizedPattern.includes('/')
  const target = hasSlash ? normalizedPath : normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
  let source = '^'
  for (let i = 0; i < normalizedPattern.length; i++) {
    const char = normalizedPattern[i]!
    if (char === '*') {
      if (normalizedPattern[i + 1] === '*') {
        if (normalizedPattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const end = normalizedPattern.indexOf(']', i + 1)
      if (end === -1) {
        source += '\\['
      } else {
        let cls = normalizedPattern.slice(i + 1, end)
        if (cls.startsWith('!') || cls.startsWith('^')) cls = `^${cls.slice(1)}`
        source += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else {
      source += escapeRegExpChar(char)
    }
  }
  return new RegExp(`${source}$`, caseSensitive ? '' : 'i').test(target)
}

/** 外部修改判定：给定期望 mtime 时，差 >1ms 才算冲突。 */
export function mtimeConflicts(current: number, expected: number | undefined): boolean {
  return expected !== undefined && Math.abs(current - expected) > 1
}

/** watch 回调拿不到文件名时退回被监听路径；目录事件拼出变化文件的绝对路径。 */
export function watchChangedPath(
  target: string,
  filename: string | Buffer | null | undefined,
  isDir: boolean,
): string {
  const name = filename === null || filename === undefined ? null : String(filename)
  return isDir && name !== null && name.length > 0 ? path.join(target, name) : target
}

export function indexOfText(haystack: string, needle: string, caseSensitive: boolean): number {
  return caseSensitive
    ? haystack.indexOf(needle)
    : haystack.toLowerCase().indexOf(needle.toLowerCase())
}
