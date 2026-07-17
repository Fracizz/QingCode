import type { Project } from '../types'

export const RUN_TRUST_STORAGE_KEY = 'qingcode:run-trust'
export const RUN_TRUST_CHANGED_EVENT = 'qingcode:run-trust-changed'

type TrustStore = {
  /** Trusted project ids. */
  ids: string[]
  /** Trusted absolute project paths (normalized). */
  paths: string[]
}

function emptyStore(): TrustStore {
  return { ids: [], paths: [] }
}

/** Normalize project path for stable trust lookups across slash styles / trailing separators. */
export function normalizeProjectPath(path: string): string {
  return path.trim().replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase()
}

function readStore(): TrustStore {
  try {
    const raw = localStorage.getItem(RUN_TRUST_STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<TrustStore>
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const paths = Array.isArray(parsed.paths)
      ? parsed.paths
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .map(normalizeProjectPath)
      : []
    return { ids: [...new Set(ids)], paths: [...new Set(paths)] }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: TrustStore) {
  try {
    localStorage.setItem(RUN_TRUST_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Quota / private mode — trust simply will not persist.
  }
  window.dispatchEvent(new Event(RUN_TRUST_CHANGED_EVENT))
}

export function isProjectTrusted(project: Pick<Project, 'id' | 'path'>): boolean {
  const store = readStore()
  if (store.ids.includes(project.id)) return true
  return store.paths.includes(normalizeProjectPath(project.path))
}

export function trustProject(project: Pick<Project, 'id' | 'path'>): void {
  const store = readStore()
  const path = normalizeProjectPath(project.path)
  let changed = false
  if (!store.ids.includes(project.id)) {
    store.ids.push(project.id)
    changed = true
  }
  if (path && !store.paths.includes(path)) {
    store.paths.push(path)
    changed = true
  }
  if (changed) writeStore(store)
  else window.dispatchEvent(new Event(RUN_TRUST_CHANGED_EVENT))
}

export function untrustProject(project: Pick<Project, 'id' | 'path'>): void {
  const store = readStore()
  const path = normalizeProjectPath(project.path)
  const nextIds = store.ids.filter(id => id !== project.id)
  const nextPaths = store.paths.filter(p => p !== path)
  if (nextIds.length === store.ids.length && nextPaths.length === store.paths.length) return
  writeStore({ ids: nextIds, paths: nextPaths })
}
