/**
 * 终端输出中的文件路径与 OSC 8 超链接：识别、解析为编辑器路径。
 * 只做纯逻辑；打开动作在 terminalLinkActions.ts。
 *
 * 路径分属不同域（AGENTS.md）：本机 Windows、本机 POSIX、WSL、`ssh://` 资源互不混用，
 * 输出里的绝对路径只按所在项目的域解释，解释不了就放弃，不猜测。
 */
import { parseQuickOpenLocation } from '../quickOpen'

export interface TerminalFileTarget {
  path: string
  line?: number
  column?: number
}

/** `start` / `end` 是 UTF-16 下标，`end` 不含。 */
export interface TerminalFileMatch extends TerminalFileTarget {
  start: number
  end: number
}

export type TerminalHyperlink =
  | { kind: 'web'; url: string }
  | ({ kind: 'file' } & TerminalFileTarget)

/** 整条逻辑行超过此长度（压缩代码、base64 等）不识别，悬停时不做无意义的匹配。 */
const MAX_LINE_CHARS = 8192

const WORD = String.raw`[\p{L}\p{N}_.~@+$-]`
// `[id]`、`(group)` 是 Next.js 等框架的目录名；逐字符交替，避免嵌套量词回溯。
const SEGMENT = String.raw`(?:${WORD}|\[${WORD}*\]|\(${WORD}*\))+`
const PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/]+|\.{1,2}[\\/]+|[\\/]+)?${SEGMENT}(?:[\\/]+${SEGMENT})*`,
  'gu',
)
/** 带空格的路径只认引号内以绝对路径或 ./ ../ 开头的，否则会把整句话当成路径。 */
const QUOTED_PATH_RE = /(["'`])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[^"'`\r\n]*)\1/g
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi

const LOCATION_PATTERNS = [
  /^:(\d+)(?::(\d+))?(?:-\d+)?/, // a.ts:12、a.ts:12:3、a.ts:12-20
  /^\((\d+)(?:,\s*(\d+))?\)/, // a.cs(12,3)
  /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?/i, // a.ts#L12、a.ts#L12-L20
  /^["']?, line (\d+)/, // File "a.py", line 12
]

const KNOWN_FILE_NAMES = new Set([
  'Makefile', 'Dockerfile', 'Containerfile', 'Jenkinsfile', 'Justfile',
  '.env', '.gitignore', '.dockerignore', '.npmrc', '.editorconfig',
])
/** 没有目录也没有行号的单个文件名，只认这些常见扩展名，避免 `console.log` 之类的误报。 */
const BARE_FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'json5', 'md', 'mdx', 'py', 'rs', 'go', 'java',
  'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'vue', 'svelte', 'css', 'scss',
  'less', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'sh', 'bash', 'zsh', 'ps1', 'bat',
  'cmd', 'sql', 'proto', 'lock', 'txt',
])
/** `example.com:8080` 这样的主机名加端口不是文件位置。 */
const HOST_SUFFIXES = new Set(['com', 'net', 'org', 'io', 'dev', 'ai', 'cn', 'app', 'co'])
const PROSE_FILE_NAMES = /^(?:node|vue|next|nuxt|three|express|react|deno|bun)\.js$/i
const FILE_EXTENSION_RE = /[^.]\.([\p{L}_][\p{L}\p{N}_-]{0,15})$/u

function isLinkablePath(path: string, hasLocation: boolean): boolean {
  const hasSeparator = /[\\/]/.test(path)
  const name = path.split(/[\\/]/).pop() ?? ''
  if (KNOWN_FILE_NAMES.has(name)) return true
  const extension = FILE_EXTENSION_RE.exec(name)?.[1]
  // 必须能看出是文件：`src/foo`、`/api/users`、`and/or`、`image:12` 都不算。
  if (!extension) return hasSeparator && /^\.\p{L}/u.test(name)
  if (hasSeparator) return true
  const lower = extension.toLowerCase()
  if (hasLocation) return !HOST_SUFFIXES.has(lower)
  return BARE_FILE_EXTENSIONS.has(lower) && !PROSE_FILE_NAMES.test(name)
}

function matchLocation(rest: string): { length: number; line: number; column?: number } | null {
  for (const pattern of LOCATION_PATTERNS) {
    const match = pattern.exec(rest)
    if (!match) continue
    const line = Number.parseInt(match[1]!, 10)
    if (line < 1) return null
    const column = match[2] ? Number.parseInt(match[2], 10) : undefined
    return { length: match[0].length, line, ...(column && column >= 1 ? { column } : {}) }
  }
  return null
}

function overlaps(start: number, end: number, ranges: ReadonlyArray<{ start: number; end: number }>) {
  return ranges.some(range => start < range.end && range.start < end)
}

/** 去掉匹配结果两端不属于路径的字符，返回路径在原文中的范围。 */
function trimPathToken(token: string, tokenStart: number) {
  let start = tokenStart
  let core = token
  const leading = /^[@-]+/.exec(core)?.[0].length ?? 0
  if (leading) {
    core = core.slice(leading)
    start += leading
  }
  // 整个 token 只是一对括号包住的内容：(a.ts)、[a.ts]。
  while (/^(?:\([^()[\]]*\)|\[[^()[\]]*\])$/.test(core)) {
    core = core.slice(1, -1)
    start += 1
  }
  // a.cs(12) 的括号行号被目录名规则吃进了 token，退回去按位置后缀解析。
  core = core.replace(/\(\d+\)$/, '').replace(/[.-]+$/, '')
  return { core, start }
}

/** 找出一行文本中的文件路径（可带行列号）。 */
export function findTerminalFileLinks(text: string): TerminalFileMatch[] {
  if (!text || text.length > MAX_LINE_CHARS) return []
  const urls = [...text.matchAll(URL_RE)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  const links: TerminalFileMatch[] = []

  for (const match of text.matchAll(QUOTED_PATH_RE)) {
    const path = match[2]!
    if (!/\s/.test(path)) continue // 不含空格的交给下面的通用规则。
    const start = match.index + 1
    const closing = start + path.length + 1
    const location = matchLocation(text.slice(closing))
    if (overlaps(start, closing, urls) || !isLinkablePath(path, !!location)) continue
    links.push({
      start,
      end: location ? closing + location.length : closing - 1,
      path,
      ...(location ? { line: location.line, column: location.column } : {}),
    })
  }

  for (const match of text.matchAll(PATH_RE)) {
    const { core, start } = trimPathToken(match[0], match.index)
    if (!core) continue
    const coreEnd = start + core.length
    const location = matchLocation(text.slice(coreEnd))
    const end = coreEnd + (location?.length ?? 0)
    if (overlaps(start, end, urls) || overlaps(start, end, links)) continue
    if (!isLinkablePath(core, !!location)) continue
    links.push({
      start,
      end,
      path: core,
      ...(location ? { line: location.line, column: location.column } : {}),
    })
  }
  return links.sort((a, b) => a.start - b.start)
}

const EDITOR_LINK_SCHEMES = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'windsurf:'])

/**
 * 解析 OSC 8 超链接目标。`file:` 与编辑器链接（Codex 默认输出 `vscode://file/...`）
 * 转成文件位置，其余协议一律不打开。主机名不参与解析：远端程序写的是远端主机名。
 */
export function parseTerminalHyperlink(uri: string): TerminalHyperlink | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { kind: 'web', url: uri }
  const isFile =
    parsed.protocol === 'file:' ||
    (EDITOR_LINK_SCHEMES.has(parsed.protocol) && parsed.hostname === 'file')
  if (!isFile) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  const native = /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname
  const { fileQuery, line, column } = parseQuickOpenLocation(`${native}${parsed.hash}`)
  if (!fileQuery) return null
  return {
    kind: 'file',
    path: fileQuery,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  }
}

interface PathParts {
  prefix: string
  parts: string[]
  sep: '/' | '\\'
}

function splitPath(path: string): PathParts {
  const uri = /^(?:ssh|wsl):\/\/[^/]+/.exec(path)?.[0]
  const prefix = uri ?? /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(path)?.[0] ?? /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  return {
    prefix,
    parts: path.slice(prefix.length).split(/[\\/]+/).filter(Boolean),
    sep: !uri && path.includes('\\') ? '\\' : '/',
  }
}

/** 按项目所在的域解释输出里的绝对路径，解释不了返回 null。 */
function absoluteInProjectDomain(raw: string, root: PathParts): PathParts | null {
  const isDrive = /^[A-Za-z]:[\\/]/.test(raw)
  const isUnc = /^[\\/]{2}[^\\/]/.test(raw)
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  if (root.prefix.startsWith('ssh://')) {
    // Windows OpenSSH 的远端根目录写作 ssh://id/D:/code/app，输出里是 D:\code\app。
    return isUnc ? null : { prefix: root.prefix, parts, sep: '/' }
  }
  if (/^(?:wsl:|[\\/]{2}wsl)/i.test(root.prefix)) {
    if (isDrive || isUnc) return null
    return { prefix: root.prefix, parts, sep: root.sep }
  }
  if (root.prefix) {
    // 本机 Windows：`/usr/bin/x` 这样的路径来自 WSL 或 Git Bash，不做跨系统映射。
    if (!isDrive && !isUnc) return null
    return { ...splitPath(raw), sep: root.sep }
  }
  return isDrive || isUnc ? null : { prefix: '', parts, sep: '/' }
}

/** 处理 `.` 和 `..`；越过根目录返回 null。 */
function collapseSegments(parts: readonly string[]): string[] | null {
  const out: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out
}

function isUnderRoot(path: PathParts, root: PathParts) {
  if (path.prefix.toLowerCase() !== root.prefix.toLowerCase()) return false
  if (path.parts.length < root.parts.length) return false
  const caseSensitive = root.prefix.startsWith('ssh://') || !root.prefix
  return root.parts.every((part, index) => {
    const other = path.parts[index]!
    return caseSensitive ? other === part : other.toLowerCase() === part.toLowerCase()
  })
}

/** 解析成候选的编辑器路径，按优先级排列。SSH 项目的结果都在项目根目录内。 */
export function terminalFileCandidates(
  rawPath: string,
  context: { root: string; cwd?: string; projectName?: string },
): string[] {
  const root = splitPath(context.root)
  const isSsh = root.prefix.startsWith('ssh://')
  const rawParts = rawPath.split(/[\\/]+/).filter(Boolean)
  const isAbsolute = /^(?:[A-Za-z]:)?[\\/]/.test(rawPath)
  const results: string[] = []

  const add = (candidate: PathParts) => {
    const parts = collapseSegments(candidate.parts)
    if (!parts) return
    const path = { ...candidate, parts }
    const under = isUnderRoot(path, root)
    if (isSsh && !under) return
    // 根目录内统一成项目自己的写法：编辑器按路径字符串匹配已打开的标签。
    const resolved = under
      ? `${root.prefix}${root.sep}${[...root.parts, ...parts.slice(root.parts.length)].join(root.sep)}`
      : `${path.prefix}${path.sep}${parts.join(path.sep)}`
    if (!results.includes(resolved)) results.push(resolved)
  }

  if (isAbsolute) {
    const absolute = absoluteInProjectDomain(rawPath, root)
    if (absolute) add(absolute)
    return results
  }

  const bases = context.cwd ? [splitPath(context.cwd), root] : [root]
  const variants = [rawParts]
  // git diff 的 a/ b/ 前缀；Alt+C 引用的 @项目名/ 前缀。
  if (rawParts.length > 1 && (rawParts[0] === 'a' || rawParts[0] === 'b')) variants.push(rawParts.slice(1))
  if (rawParts.length > 1 && rawParts[0] === context.projectName) variants.push(rawParts.slice(1))
  for (const variant of variants) {
    for (const base of bases) add({ ...base, parts: [...base.parts, ...variant] })
  }
  return results
}

/** xterm buffer 中本模块用到的最小接口，便于单测。 */
export interface TerminalBufferLike {
  getLine(y: number):
    | {
        isWrapped: boolean
        length: number
        getCell(x: number): { getChars(): string; getWidth(): number } | undefined
      }
    | undefined
}

export interface TerminalBufferRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/**
 * 找出 y（0 起始）所在逻辑行（含自动折行）的文件路径，
 * 换算成 xterm 的 1 起始、两端包含的单元格范围。中文占两列，按单元格映射。
 */
export function terminalBufferFileLinks(
  buffer: TerminalBufferLike,
  y: number,
): Array<{ range: TerminalBufferRange; target: TerminalFileTarget }> {
  let first = y
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1
  let last = y
  while (buffer.getLine(last + 1)?.isWrapped) last += 1

  let text = ''
  const cells: Array<{ x: number; y: number; width: number }> = []
  for (let row = first; row <= last; row += 1) {
    const line = buffer.getLine(row)
    if (!line) continue
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      const width = cell?.getWidth() ?? 1
      if (width === 0) continue
      const chars = cell?.getChars() || ' '
      for (let index = 0; index < chars.length; index += 1) cells.push({ x, y: row, width })
      text += chars
    }
  }

  return findTerminalFileLinks(text).map(({ start, end, ...target }) => {
    const from = cells[start]!
    const to = cells[end - 1]!
    return {
      target,
      range: {
        start: { x: from.x + 1, y: from.y + 1 },
        end: { x: to.x + to.width, y: to.y + 1 },
      },
    }
  })
}
