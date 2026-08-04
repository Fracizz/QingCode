export type TypeFilter = { kind: 'ext'; ext: string } | { kind: 'star'; exts: string[] }

/** Filename-result filter under 全部 / 文件名 modes. */
export type EntryKindFilter = 'all' | 'dir' | 'file'

export interface ContentSearchMatch {
  line: number
  text: string
  match_start: number
  match_end: number
}

export interface ContentSearchFileResult {
  name: string
  path: string
  relative: string
  matches: ContentSearchMatch[]
}

export type FilenameSearchHit = {
  name: string
  path: string
  relative: string
  is_dir: boolean
}

export type SearchResultRow =
  | { kind: 'section'; id: 'filename' | 'content'; label: string }
  | { kind: 'file'; path: string; name: string; dir: string; matchCount: number; collapsed: boolean }
  | { kind: 'match'; path: string; line: number; text: string; matchStart: number; matchEnd: number }
  | { kind: 'more'; path: string }
  | { kind: 'dir'; dir: string }
  | { kind: 'fn'; hit: FilenameSearchHit }
  | { kind: 'footer'; loading: boolean; hasMore: boolean }

/** Progressive search budgets for truncated result load-more. */
export const SEARCH_RESULT_BUDGETS = [200, 500, 1000, 2000] as const
export const SEARCH_PREFETCH_ROWS = 12
export const SEARCH_FOOTER_HEIGHT = 22

export function nextSearchBudget(current: number): number | null {
  const next = SEARCH_RESULT_BUDGETS.find(budget => budget > current)
  return next ?? null
}

export function filterFilenameHits<T extends { is_dir: boolean }>(
  hits: T[],
  entryKind: EntryKindFilter,
): T[] {
  if (entryKind === 'dir') return hits.filter(hit => hit.is_dir)
  if (entryKind === 'file') return hits.filter(hit => !hit.is_dir)
  return hits
}

export function typeFilterLabel(filter: TypeFilter | null): string {
  if (!filter) return '全部类型'
  if (filter.kind === 'star') return '*'
  return `.${filter.ext}`
}

export function typeFilterExtensions(filter: TypeFilter | null): string[] | null {
  if (!filter) return null
  return filter.kind === 'ext' ? [filter.ext] : filter.exts
}

export function isGlobPattern(query: string): boolean {
  return query.includes('*') || query.includes('?')
}

export function rowHeightOf(row: SearchResultRow): number {
  switch (row.kind) {
    case 'section':
      return 26
    case 'file':
      return 24
    case 'match':
      return 22
    case 'more':
      return 18
    case 'dir':
      return 20
    case 'fn':
      return 22
    case 'footer':
      return SEARCH_FOOTER_HEIGHT
  }
}

/** Group filename hits by directory (and project name when multi-root). */
export function buildFilenameResultRows(
  hits: FilenameSearchHit[],
  projectNameOf: (path: string) => string | null,
): SearchResultRow[] {
  const groups = new Map<string, FilenameSearchHit[]>()
  for (const h of hits) {
    const sep = h.relative.includes('\\') ? '\\' : '/'
    const parts = h.relative.split(sep)
    const dir = parts.length > 1 ? parts.slice(0, -1).join(sep) : '(root)'
    const project = projectNameOf(h.path)
    const groupKey = project ? `${project} / ${dir}` : dir
    const arr = groups.get(groupKey) ?? []
    arr.push(h)
    groups.set(groupKey, arr)
  }
  const out: SearchResultRow[] = []
  for (const [dir, items] of groups) {
    out.push({ kind: 'dir', dir })
    for (const h of items) out.push({ kind: 'fn', hit: h })
  }
  return out
}

/** Flatten content matches into collapsible file / match / more rows. */
export function buildContentResultRows(
  files: ContentSearchFileResult[],
  collapsedFiles: Set<string>,
  projectNameOf: (path: string) => string | null,
  maxMatchesPerFile: number,
): SearchResultRow[] {
  const out: SearchResultRow[] = []
  for (const file of files) {
    const collapsed = collapsedFiles.has(file.path)
    const project = projectNameOf(file.path)
    const dir = dirOf(file.relative)
    out.push({
      kind: 'file',
      path: file.path,
      name: file.name,
      dir: project && dir ? `${project} / ${dir}` : project ? project : dir,
      matchCount: file.matches.length,
      collapsed,
    })
    if (!collapsed) {
      for (const m of file.matches) {
        out.push({
          kind: 'match',
          path: file.path,
          line: m.line,
          text: m.text,
          matchStart: m.match_start,
          matchEnd: m.match_end,
        })
      }
      if (file.matches.length >= maxMatchesPerFile) {
        out.push({ kind: 'more', path: file.path })
      }
    }
  }
  return out
}

export function dirOf(relative: string): string {
  const sep = relative.includes('\\') ? '\\' : '/'
  const parts = relative.split(sep).filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join(sep)
}

export function isNavigable(row: SearchResultRow): boolean {
  return row.kind === 'file' || row.kind === 'match' || row.kind === 'fn'
}

export function countFilenameKinds(hits: FilenameSearchHit[]): {
  dirs: number
  files: number
} {
  let dirs = 0
  let files = 0
  for (const hit of hits) {
    if (hit.is_dir) dirs += 1
    else files += 1
  }
  return { dirs, files }
}

/** Keep at most `maxMatches` matches across files (prefix of the list). */
export function trimContentFiles(
  files: ContentSearchFileResult[],
  maxMatches: number,
): ContentSearchFileResult[] {
  const out: ContentSearchFileResult[] = []
  let remaining = maxMatches
  for (const file of files) {
    if (remaining <= 0) break
    if (file.matches.length <= remaining) {
      out.push(file)
      remaining -= file.matches.length
    } else {
      out.push({ ...file, matches: file.matches.slice(0, remaining) })
      remaining = 0
    }
  }
  return out
}
