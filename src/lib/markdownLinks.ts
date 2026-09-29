/** Resolve links in an editor preview without involving the WebView's app origin. */
export type MarkdownLinkTarget =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'unsupported' }

const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i
const SCHEME = /^[a-z][a-z\d+.-]*:/i

export function resolveMarkdownLink(
  markdownPath: string,
  href: string,
  projectRoot?: string,
): MarkdownLinkTarget {
  const source = href.trim()
  if (!source) return { kind: 'unsupported' }
  if (source.startsWith('#')) {
    try {
      return { kind: 'anchor', id: decodeURIComponent(source.slice(1)) }
    } catch {
      return { kind: 'unsupported' }
    }
  }
  if (/^(https?:|mailto:)/i.test(source)) return { kind: 'external', url: source }
  if (source.startsWith('//')) return { kind: 'unsupported' }

  const isSsh = markdownPath.startsWith('ssh://')
  const rootRelative = source.startsWith('/') && Boolean(projectRoot)
  const normalized = (rootRelative && projectRoot ? `${projectRoot.replace(/\/+$/, '')}/` : markdownPath)
    .replace(/\\/g, '/')
  const base = isSsh ? normalized : `file:///${normalized.replace(/^\/+/, '')}`
  const localSource = WINDOWS_ABSOLUTE.test(source)
    ? `file:///${source.replace(/\\/g, '/')}`
    : rootRelative ? source.slice(1) : source
  if (SCHEME.test(localSource) && !/^file:/i.test(localSource) && !/^ssh:/i.test(localSource)) {
    return { kind: 'unsupported' }
  }
  if (/^ssh:/i.test(localSource) && !isSsh) return { kind: 'unsupported' }

  try {
    const url = new URL(localSource, base)
    if (isSsh ? url.protocol !== 'ssh:' || url.host !== new URL(base).host : url.protocol !== 'file:') {
      return { kind: 'unsupported' }
    }
    const pathname = decodeURIComponent(url.pathname)
    const path = isSsh
      ? `ssh://${url.host}${pathname}`
      : url.host
        ? `//${url.host}${pathname}`
        : pathname.replace(/^\/([a-z]:\/)/i, '$1')
    const lineMatch = /^#L([1-9]\d*)(?:-L[1-9]\d*)?$/i.exec(url.hash)
    return { kind: 'file', path, ...(lineMatch ? { line: Number(lineMatch[1]) } : {}) }
  } catch {
    return { kind: 'unsupported' }
  }
}
