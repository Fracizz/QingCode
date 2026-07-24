import type { FileNode } from './fileTreeCache'
import { fuzzyScore } from './commands'
import { normalizePath, parseFileReference } from '../utils/fileReferences'

export type QuickOpenEntry = {
  id: string
  path: string
  label: string
  relativePath: string
  projectName: string
}

export type QuickOpenProject = {
  id: string
  name: string
  path: string
}

/** Native filename-search result. Keep this separate from the lazy explorer tree. */
export type QuickOpenSearchHit = {
  name: string
  path: string
  relative: string
  is_dir: boolean
}

function projectRelativePath(projectPath: string, filePath: string) {
  const root = normalizePath(projectPath)
  const file = normalizePath(filePath)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1)
  }
  return file.split('/').pop() || file
}

function walkFiles(
  nodes: FileNode[],
  out: QuickOpenEntry[],
  projectPath: string,
  projectName: string,
) {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) walkFiles(node.children, out, projectPath, projectName)
      continue
    }
    out.push({
      id: node.path,
      path: node.path,
      label: node.name,
      relativePath: projectRelativePath(projectPath, node.path),
      projectName,
    })
  }
}

export function collectQuickOpenFiles(
  projects: QuickOpenProject[],
  projectTrees: Record<string, FileNode[]>,
): QuickOpenEntry[] {
  const out: QuickOpenEntry[] = []
  for (const project of projects) {
    const tree = projectTrees[project.id]
    if (!tree) continue
    walkFiles(tree, out, project.path, project.name)
  }
  return mergeQuickOpenEntries(out)
}

/** Convert full-project native filename hits into the palette's shared entry shape. */
export function quickOpenEntriesFromSearchHits(
  project: QuickOpenProject,
  hits: QuickOpenSearchHit[],
): QuickOpenEntry[] {
  return hits
    .filter(hit => !hit.is_dir)
    .map(hit => ({
      id: hit.path,
      path: hit.path,
      label: hit.name,
      relativePath: hit.relative.replace(/\\/g, '/'),
      projectName: project.name,
    }))
}

/** Prefer the immediately available tree results, then fill gaps from native search. */
const QUICK_OPEN_LOCATION_SUFFIX_RE = /:(\d+)(?::(\d+))?$/

export type QuickOpenLocation = {
  fileQuery: string
  line?: number
  column?: number
  /** From `@ProjectName/…` Alt+C references. */
  projectName?: string
}

function parseColonLocation(input: string): Pick<QuickOpenLocation, 'fileQuery' | 'line' | 'column'> {
  const match = input.match(QUICK_OPEN_LOCATION_SUFFIX_RE)
  if (!match || match.index === undefined) {
    return { fileQuery: input }
  }

  const fileQuery = input.slice(0, match.index)
  if (fileQuery === '' && /^[a-zA-Z]:/.test(input)) {
    return { fileQuery: input }
  }
  if (/^[a-zA-Z]$/.test(fileQuery) && /^[a-zA-Z]:\d/.test(input)) {
    return { fileQuery: input }
  }

  const line = Number.parseInt(match[1]!, 10)
  const column = match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined
  if (!Number.isFinite(line) || line < 1) {
    return { fileQuery: input }
  }
  if (column !== undefined && (!Number.isFinite(column) || column < 1)) {
    return { fileQuery: input, line }
  }
  return { fileQuery, line, column }
}

/**
 * Split location / project prefix from the fuzzy file query.
 * Supports VS Code `file:line[:column]` and Alt+C `@Project/rel#Lline[-Lend]`.
 */
export function parseQuickOpenLocation(query: string): QuickOpenLocation {
  const trimmed = query.trim()
  if (!trimmed) return { fileQuery: '' }

  const ref = parseFileReference(trimmed)
  if (ref.line !== undefined) {
    return {
      fileQuery: ref.fileQuery,
      line: ref.line,
      ...(ref.projectName ? { projectName: ref.projectName } : {}),
    }
  }

  const colon = parseColonLocation(ref.fileQuery)
  return {
    fileQuery: colon.fileQuery,
    ...(colon.line !== undefined ? { line: colon.line } : {}),
    ...(colon.column !== undefined ? { column: colon.column } : {}),
    ...(ref.projectName ? { projectName: ref.projectName } : {}),
  }
}

export function mergeQuickOpenEntries(...groups: ReadonlyArray<readonly QuickOpenEntry[]>): QuickOpenEntry[] {
  const seen = new Set<string>()
  const merged: QuickOpenEntry[] = []
  for (const group of groups) {
    for (const entry of group) {
      const key = entry.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }
  return merged
}

export function filterQuickOpenFiles(
  entries: QuickOpenEntry[],
  query: string,
  limit = 12,
): Array<QuickOpenEntry & { score: number }> {
  const { fileQuery, projectName } = parseQuickOpenLocation(query)
  const scoped = projectName
    ? entries.filter(entry => entry.projectName.toLowerCase() === projectName.toLowerCase())
    : entries
  const pool = projectName && scoped.length > 0 ? scoped : entries

  if (!fileQuery) {
    return pool.slice(0, limit).map(entry => ({ ...entry, score: 1 }))
  }
  const needle = fileQuery.replace(/\\/g, '/')
  const needleLower = needle.toLowerCase()
  const ranked = pool
    .map(entry => {
      const relative = entry.relativePath.replace(/\\/g, '/')
      if (relative.toLowerCase() === needleLower) {
        return { ...entry, score: Number.POSITIVE_INFINITY }
      }
      const fields = [
        entry.label,
        relative,
        entry.path.replace(/\\/g, '/'),
        entry.projectName,
      ]
      const score = Math.max(...fields.map(field => fuzzyScore(needle, field)))
      return score > 0 ? { ...entry, score } : null
    })
    .filter((entry): entry is QuickOpenEntry & { score: number } => entry !== null)
  ranked.sort(
    (a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath, 'zh-CN'),
  )
  return ranked.slice(0, limit)
}
