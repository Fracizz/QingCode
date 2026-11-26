// 文件路径与链接识别：纯字符串运算，渲染进程组件与单测共用，不触碰 IO。

import { normalizeLang } from '../../lib/highlight'

export type FileLocation = {
  path: string
  line?: number
  column?: number
}

export type PathMatch = {
  start: number
  end: number
  raw: string
  path: string
  line?: number
  column?: number
}

export type FileKind = 'image' | 'markdown' | 'text'
export type PathStyle = 'posix' | 'windows'

const DRIVE = /^[A-Za-z]:[\\/]/
const UNC = /^[\\/]{2}/
/** file:///C:/a 或 /C:/a 这类"带斜杠的盘符"路径。 */
const WINISH_ROOT = /^\/[A-Za-z]:[\\/]/
const OTHER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const FILE_EXT = /\.[A-Za-z][A-Za-z0-9_+~-]{0,15}$/
const SPECIAL_PREFIX = /^(?:\.{1,2}|~)[\\/]/
const HOME_PREFIX = /^~[\\/]/
const FRAGMENT = /^L?(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i
const COLON_SUFFIX = /:(\d+)(?::(\d+))?$/
const SEPARATORS = /[\\/]+/

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx'])
const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/** 按路径自身判断风格；相对路径由调用方（cwd）决定风格。 */
export function pathStyle(path: string): PathStyle {
  const value = path.trim()
  if (DRIVE.test(value) || UNC.test(value) || WINISH_ROOT.test(value)) return 'windows'
  return value.includes('\\') ? 'windows' : 'posix'
}

function separatorFor(path: string, style: PathStyle): '\\' | '/' {
  if (style === 'posix') return '/'
  return path.includes('\\') ? '\\' : '/'
}

function splitRoot(
  value: string,
  sep: '\\' | '/',
  style: PathStyle,
): { root: string; rest: string } {
  if (style === 'windows') {
    const drive = /^([A-Za-z]:)[\\/]+/.exec(value)
    if (drive) return { root: `${drive[1]}${sep}`, rest: value.slice(drive[0].length) }
    if (/^[A-Za-z]:$/.test(value)) return { root: `${value}${sep}`, rest: '' }
    const unc = /^[\\/]{2,}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(value)
    if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}\\`, rest: value.slice(unc[0].length) }
    if (/^[\\/]/.test(value)) return { root: sep, rest: value.replace(/^[\\/]+/, '') }
    return { root: '', rest: value }
  }
  if (/^\//.test(value)) return { root: '/', rest: value.replace(/^\/+/, '') }
  return { root: '', rest: value }
}

/** 折叠重复分隔符并解析 . / ..；盘符根、POSIX 根、UNC 根都保留。 */
export function normalizePath(path: string, style: PathStyle = pathStyle(path)): string {
  let value = path.trim()
  if (!value) return ''
  let activeStyle = style
  if (WINISH_ROOT.test(value)) {
    value = value.slice(1)
    activeStyle = 'windows'
  }
  const sep = separatorFor(value, activeStyle)
  const { root, rest } = splitRoot(value, sep, activeStyle)
  const segments: string[] = []
  for (const part of rest.split(SEPARATORS)) {
    if (!part || part === '.') continue
    if (part === '..') {
      const last = segments[segments.length - 1]
      if (last && last !== '..') segments.pop()
      else if (!root) segments.push('..')
      continue
    }
    segments.push(part)
  }
  const joined = segments.join(sep)
  if (root) return root + joined
  return joined || (value.startsWith('.') ? '.' : '')
}

export function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path.trim())
}

/** 以 base（通常是 cwd）的分隔符风格拼接并规范化；绝对片段会重置 base。 */
export function joinPath(base: string, ...parts: string[]): string {
  const style = pathStyle(base)
  const sep = separatorFor(base, style)
  let combined = base.trim()
  for (const part of parts) {
    const piece = part.trim()
    if (!piece) continue
    if (isAbsolutePath(piece)) {
      combined = piece
      continue
    }
    const unified = piece.split(SEPARATORS).join(sep)
    if (!combined) combined = unified
    else combined = `${combined.replace(/[\\/]+$/, '')}${sep}${unified}`
  }
  return normalizePath(combined, style)
}

export function basename(path: string): string {
  const normalized = normalizePath(path)
  if (!normalized) return ''
  const parts = normalized.split(SEPARATORS).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export function dirname(path: string): string {
  const normalized = normalizePath(path)
  if (!normalized) return ''
  const sep = separatorFor(normalized, pathStyle(normalized))
  if (/^(?:[\\/]|[A-Za-z]:[\\/])$/.test(normalized)) return normalized
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(normalized)) return normalized
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (index < 0) return ''
  const parent = normalized.slice(0, index)
  if (!parent) return sep
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${sep}`
  return parent
}

export function extname(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index)
}

export function fileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  return 'text'
}

/** 图片按扩展名取 MIME；svg 走 XML 类型但同样按 <img> 显示。 */
export function imageMime(path: string): string {
  return IMAGE_MIMES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** fs.read 以 base64 返回图片；若已是 data URL 则直接用。 */
export function imageDataUrl(content: string, path: string): string {
  const value = content.trim()
  if (!value) return ''
  if (/^data:/i.test(value)) return value
  return `data:${imageMime(path)};base64,${value}`
}

/** 扩展名优先，其次文件名（Dockerfile / Makefile）；无法识别时按纯文本。 */
export function langForPath(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase()
  return normalizeLang(ext || basename(path).toLowerCase())
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // 非法 % 转义按字面量处理，避免整条链接失效。
    return value
  }
}

function positive(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** 拆出 #L12 / #L12C3 / #L12-L20 与尾部 :12[:3]；不改动路径本体。 */
export function splitLocation(input: string): FileLocation {
  let path = input
  let line: number | undefined
  let column: number | undefined
  const hash = path.indexOf('#')
  if (hash >= 0) {
    const fragment = path.slice(hash + 1)
    path = path.slice(0, hash)
    const match = FRAGMENT.exec(fragment)
    if (match) {
      line = positive(match[1])
      column = positive(match[2])
    }
  }
  const suffix = COLON_SUFFIX.exec(path)
  // C:12 是盘符相对写法，不是行号后缀。
  if (suffix && !/^[A-Za-z]:\d/.test(path)) {
    path = path.slice(0, suffix.index)
    if (line === undefined) line = positive(suffix[1])
    if (column === undefined) column = positive(suffix[2])
  }
  const result: FileLocation = { path }
  if (line !== undefined) result.line = line
  if (column !== undefined) result.column = column
  return result
}

/**
 * 把 Markdown / 文本里的 href 解析为本地文件位置；其他协议返回 null。
 * 相对路径按 cwd 解析（cwd 为空时无法解析）；~/ 原样保留（渲染进程不知道目标机 home）。
 */
export function parseFileHref(href: string, cwd: string): FileLocation | null {
  let raw = href.trim()
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim()
  if (!raw) return null

  let candidate: string
  if (/^file:/i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    let pathname = url.pathname
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
      pathname = `//${url.hostname}${pathname}`
    }
    candidate = `${pathname}${url.hash}`
  } else {
    if (!DRIVE.test(raw) && OTHER_SCHEME.test(raw)) return null
    const query = raw.indexOf('?')
    candidate = query >= 0 ? raw.slice(0, query) : raw
  }

  const location = splitLocation(candidate)
  let path = decode(location.path).trim()
  if (!path) return null
  if (WINISH_ROOT.test(path)) path = path.slice(1)

  let resolved: string
  if (isAbsolutePath(path) || HOME_PREFIX.test(path)) {
    resolved = normalizePath(path, pathStyle(path))
  } else {
    const base = cwd.trim()
    if (!base) return null
    resolved = joinPath(base, path)
  }
  if (!resolved || /^[A-Za-z]$/.test(resolved)) return null

  const result: FileLocation = { path: resolved }
  if (location.line !== undefined) result.line = location.line
  if (location.column !== undefined) result.column = location.column
  return result
}

/** 文本 token：尽量宽（含中文），但排除空白与常见标点/分隔符。 */
const TOKEN = /[^\s<>"'`()\[\]{},;|!?=&*]+/g
const TRAILING = /[.:#%+\-~\\/]+$/
const DOMAIN_FIRST = /^[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\.[A-Za-z]{2,})?$/

/** 在行内代码、命令输出、普通文本中找出可点击的路径片段。 */
export function findPathsInText(text: string): PathMatch[] {
  if (!text) return []
  const matches: PathMatch[] = []
  const token = new RegExp(TOKEN.source, 'g')
  let found: RegExpExecArray | null
  while ((found = token.exec(text)) !== null) {
    const raw = found[0].replace(TRAILING, '')
    if (raw.length < 2) continue
    // URL、邮箱/scp、盘符之外的 xx: 写法都不当路径。
    if (raw.includes('://') || raw.includes('@')) continue
    if (!DRIVE.test(raw) && OTHER_SCHEME.test(raw)) continue
    const first = raw.split(SEPARATORS)[0] ?? ''
    if (/^www\./i.test(first) || DOMAIN_FIRST.test(first)) continue

    const location = splitLocation(raw)
    const path = decode(location.path)
    if (!path || /^[A-Za-z]$/.test(path)) continue
    if (!/[\\/]/.test(path)) continue
    if (/:/.test(path) && !/^[A-Za-z]:/.test(path)) continue
    const segments = path.split(SEPARATORS).filter(Boolean)
    const last = segments[segments.length - 1] ?? ''
    const special = SPECIAL_PREFIX.test(path)
    if (!FILE_EXT.test(last) && !special) continue
    // 纯数字比例 / 版本号不当文件。
    if (/^[\d.\\/]+$/.test(path)) continue

    const item: PathMatch = { start: found.index, end: found.index + raw.length, raw, path }
    if (location.line !== undefined) item.line = location.line
    if (location.column !== undefined) item.column = location.column
    matches.push(item)
  }
  return matches
}
