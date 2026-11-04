const REMOTE_OR_EMBEDDED_SCHEME = /^(?:https?:|data:|blob:)/iu
const OTHER_SCHEME = /^[a-z][a-z\d+.-]*:/iu
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/iu

function stripQueryAndFragment(source: string): string {
  const marker = source.search(/[?#]/u)
  return marker >= 0 ? source.slice(0, marker) : source
}

function decodePath(source: string): string {
  try {
    return decodeURIComponent(source)
  } catch {
    return source
  }
}

function normalizeAbsolutePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  const unc = normalized.startsWith('//')
  const drive = WINDOWS_ABSOLUTE.test(normalized) ? normalized.slice(0, 2) : ''
  const start = unc ? 2 : drive ? 3 : normalized.startsWith('/') ? 1 : 0
  const segments = normalized.slice(start).split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      resolved.pop()
    } else {
      resolved.push(segment)
    }
  }
  if (unc) return `//${resolved.join('/')}`
  if (drive) return `${drive}/${resolved.join('/')}`
  return `/${resolved.join('/')}`
}

function fileUrlPath(source: string): string | null {
  if (!source.toLocaleLowerCase().startsWith('file:')) return null
  try {
    const url = new URL(source)
    const pathname = decodePath(url.pathname)
    if (url.host) return normalizeAbsolutePath(`//${url.host}${pathname}`)
    return normalizeAbsolutePath(pathname.replace(/^\/([a-z]:\/)/iu, '$1'))
  } catch {
    return null
  }
}

/** Resolve a Markdown image source against the directory containing its `.md` file. */
export function resolveMarkdownLocalImagePath(
  markdownPath: string,
  source: string | undefined,
): string | null {
  const trimmed = source?.trim()
  if (!trimmed || trimmed.startsWith('#') || REMOTE_OR_EMBEDDED_SCHEME.test(trimmed)) return null

  const fromFileUrl = fileUrlPath(trimmed)
  if (fromFileUrl) return fromFileUrl

  const sourcePath = decodePath(stripQueryAndFragment(trimmed))
  if (WINDOWS_ABSOLUTE.test(sourcePath) || sourcePath.startsWith('\\\\')) {
    return normalizeAbsolutePath(sourcePath)
  }
  if (OTHER_SCHEME.test(trimmed)) return null
  if (sourcePath.startsWith('/')) return normalizeAbsolutePath(sourcePath)

  const normalizedMarkdown = markdownPath.replace(/\\/gu, '/')
  const separator = normalizedMarkdown.lastIndexOf('/')
  if (separator < 0) return null
  return normalizeAbsolutePath(`${normalizedMarkdown.slice(0, separator)}/${sourcePath}`)
}
