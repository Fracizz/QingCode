const DRAFTS_KEY = 'qingcode:unsaved-drafts'
const MAX_DRAFT_CHARS = 512 * 1024
const MAX_DRAFTS = 40

export type UnsavedDraft = {
  path: string
  content: string
  updatedAt: number
  projectId?: string
}

export type DraftSnapshotTab = {
  id: string
  path: string
  dirty: boolean
  loading?: boolean
  openError?: string
  content?: string
}

type DraftMap = Record<string, UnsavedDraft>

export function normalizeDraftPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function normalizePath(path: string): string {
  return normalizeDraftPath(path)
}

export function getDraft(path: string): UnsavedDraft | null {
  return readMap()[normalizePath(path)] ?? null
}

function readMap(): DraftMap {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as DraftMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: DraftMap) {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(map))
  } catch {
    // Quota exceeded — drop oldest.
    const entries = Object.values(map).sort((a, b) => a.updatedAt - b.updatedAt)
    while (entries.length > 5) {
      const drop = entries.shift()
      if (!drop) break
      delete map[normalizePath(drop.path)]
    }
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(map))
    } catch {
      /* ignore */
    }
  }
}

export function listUnsavedDrafts(): UnsavedDraft[] {
  return Object.values(readMap()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function clearDraft(path: string) {
  const map = readMap()
  delete map[normalizePath(path)]
  writeMap(map)
}

export function clearAllDrafts() {
  try {
    localStorage.removeItem(DRAFTS_KEY)
  } catch {
    /* ignore */
  }
}

export function persistDraft(path: string, content: string, projectId?: string) {
  if (!path || content.length > MAX_DRAFT_CHARS) return
  const map = readMap()
  map[normalizePath(path)] = {
    path,
    content,
    updatedAt: Date.now(),
    projectId,
  }
  const entries = Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt)
  if (entries.length > MAX_DRAFTS) {
    for (const drop of entries.slice(MAX_DRAFTS)) {
      delete map[normalizePath(drop.path)]
    }
  }
  writeMap(map)
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced snapshot of dirty tabs into localStorage for crash recovery.
 * Callers supply tab snapshots + content resolver to avoid store import cycles.
 */
export function scheduleDraftPersist(
  getTabs: () => DraftSnapshotTab[],
  getContent: (tabId: string) => string | null,
) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const dirty = getTabs().filter(t => t.dirty && !t.openError && !t.loading)
    const map = readMap()
    const keep = new Set(dirty.map(t => normalizePath(t.path)))
    for (const key of Object.keys(map)) {
      if (!keep.has(key)) delete map[key]
    }
    for (const tab of dirty) {
      const content = getContent(tab.id) ?? tab.content
      if (content === undefined || content.length > MAX_DRAFT_CHARS) continue
      map[normalizePath(tab.path)] = {
        path: tab.path,
        content,
        updatedAt: Date.now(),
      }
    }
    writeMap(map)
  }, 800)
}

export function clearDraftForTab(path: string) {
  clearDraft(path)
}
