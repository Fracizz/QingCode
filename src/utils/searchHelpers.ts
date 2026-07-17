export type TypeFilter = { kind: 'ext'; ext: string } | { kind: 'star'; exts: string[] }

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

export type SearchResultRow =
  | { kind: 'file'; path: string; name: string; dir: string; matchCount: number; collapsed: boolean }
  | { kind: 'match'; path: string; line: number; text: string; matchStart: number; matchEnd: number }
  | { kind: 'more'; path: string }
  | { kind: 'dir'; dir: string }
  | { kind: 'fn'; hit: { name: string; path: string; relative: string; is_dir: boolean } }

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
  }
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
