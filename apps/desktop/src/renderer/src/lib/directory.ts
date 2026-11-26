// 目录浏览是纯路径字符串运算：Windows 与 POSIX 都可能来自远端，统一按分隔符推断。

export type FsEntry = { name: string; kind: string }
export type FsListResult = { path: string; entries: FsEntry[] }
export type PathHistory = { entries: string[]; index: number }

const ROOT = /^(?:[A-Za-z]:[\\/]|[\\/])$/
const TRAILING = /[\\/]+$/
const SEPARATOR = /[\\/]/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  if (ROOT.test(trimmed)) return trimmed
  return trimmed.replace(TRAILING, '')
}

export function pathSeparator(path: string): '\\' | '/' {
  return path.includes('\\') ? '\\' : '/'
}

export function joinPath(base: string, name: string): string {
  const child = name.replace(/^[\\/]+/, '').replace(TRAILING, '')
  if (!child) return normalizePath(base)
  const parent = normalizePath(base)
  if (!parent) return child
  if (TRAILING.test(parent)) return `${parent}${child}`
  return `${parent}${pathSeparator(parent)}${child}`
}

export function parentPath(path: string): string {
  const current = normalizePath(path)
  if (!current || ROOT.test(current)) return current
  const separator = pathSeparator(current)
  const index = current.lastIndexOf(separator)
  if (index < 0) return ''
  const parent = current.slice(0, index)
  if (!parent) return separator
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separator}`
  return normalizePath(parent)
}

export function baseName(path: string): string {
  const current = normalizePath(path)
  if (!current) return ''
  const parts = current.split(SEPARATOR)
  return parts[parts.length - 1] ?? current
}

export function defaultProjectName(path: string): string {
  return baseName(path) || path.trim() || '未命名项目'
}

export function parseFsList(value: unknown): FsListResult {
  if (!isRecord(value)) return { path: '', entries: [] }
  const path = typeof value.path === 'string' ? value.path : ''
  const raw = Array.isArray(value.entries) ? value.entries : []
  const entries: FsEntry[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string') continue
    entries.push({ name: item.name, kind: typeof item.kind === 'string' ? item.kind : 'file' })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { path, entries }
}

export function initHistory(path: string): PathHistory {
  const current = normalizePath(path)
  return current ? { entries: [current], index: 0 } : { entries: [], index: -1 }
}

export function currentPath(history: PathHistory): string {
  return history.entries[history.index] ?? ''
}

export function navigateTo(history: PathHistory, path: string): PathHistory {
  const target = normalizePath(path)
  if (!target) return history
  if (currentPath(history) === target) return history
  const entries = [...history.entries.slice(0, history.index + 1), target]
  return { entries, index: entries.length - 1 }
}

export function goBack(history: PathHistory): PathHistory {
  return history.index > 0 ? { ...history, index: history.index - 1 } : history
}

export function goForward(history: PathHistory): PathHistory {
  return history.index < history.entries.length - 1 ? { ...history, index: history.index + 1 } : history
}

export function goUp(history: PathHistory): PathHistory {
  const parent = parentPath(currentPath(history))
  if (!parent || parent === currentPath(history)) return history
  return navigateTo(history, parent)
}

export function canGoBack(history: PathHistory): boolean {
  return history.index > 0
}

export function canGoForward(history: PathHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1
}
