import type { EditorTab } from '../types'
import { editorPerfProfile, resolveEditMaxBytes } from './fileSizePolicy'
import {
  decideExternalChangeAfterRead,
  decideExternalChangeBeforeRead,
} from './externalFileChange'
import { pathsEqual } from '../utils/fileReferences'

export type SyncOpenFileOutcome =
  | 'skipped'
  | 'busy'
  | 'suppressed'
  | 'ignored'
  | 'notify-view'
  | 'update-mtime'
  | 'reloaded'
  | 'prompted-reload'
  | 'prompted-keep'
  | 'prompted-compare'
  | 'prompted-dismiss'

export type SyncConflictChoice = 'reload' | 'keep' | 'compare' | null

export type SyncOpenFileDeps = {
  isSuppressed: (path: string) => Promise<boolean>
  fileMtime: (path: string) => Promise<number | null>
  readFile: (path: string, encoding: string) => Promise<string>
  resolveEncoding: (tab: EditorTab) => Promise<string>
  /** Latest tab snapshot after awaits (dirty / closed). */
  resolveTab: (id: string) => EditorTab | undefined
  getLocalContent: (tab: EditorTab) => string
  setDiskMtime: (id: string, mtime: number | null) => void
  reloadFromDisk: (id: string, content: string, mtime: number | null) => Promise<void>
  notifyViewChanged: (tab: EditorTab) => void
  promptConflict: (input: {
    tab: EditorTab
    allowCompare: boolean
  }) => Promise<SyncConflictChoice>
  openCompare: (input: {
    tab: EditorTab
    localContent: string
    diskContent: string
    mtime: number | null
  }) => void
  flushLive: (tabId: string) => void
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** In-flight syncs keyed by normalized path — shared across watcher / focus / activate. */
const syncingPaths = new Set<string>()

export function isOpenFileSyncInFlight(path: string): boolean {
  return syncingPaths.has(normalizePathKey(path))
}

/** Test helper — clears the in-flight set between cases. */
export function resetOpenFileSyncInFlightForTests(): void {
  syncingPaths.clear()
}

export function shouldSkipOpenFileSync(tab: Pick<EditorTab, 'loading' | 'openError' | 'kind'>): boolean {
  if (tab.kind === 'diff') return true
  if (tab.loading || tab.openError) return true
  return false
}

/**
 * Sync one open tab from disk using the external-change decision core.
 * Respects suppress window, view-only shortcuts, and dirty conflict prompts.
 */
export async function syncOpenFileFromDisk(
  tab: EditorTab,
  deps: SyncOpenFileDeps,
): Promise<SyncOpenFileOutcome> {
  if (shouldSkipOpenFileSync(tab)) return 'skipped'

  const key = normalizePathKey(tab.path)
  if (syncingPaths.has(key)) return 'busy'
  syncingPaths.add(key)

  try {
    try {
      if (await deps.isSuppressed(tab.path)) return 'suppressed'
    } catch {
      /* continue when suppress probe fails */
    }

    const mtime = await deps.fileMtime(tab.path)
    const editMaxBytes = resolveEditMaxBytes(tab.path)
    const profile = editorPerfProfile(tab.fileSize ?? 0, editMaxBytes)
    const beforeRead = decideExternalChangeBeforeRead({
      viewMode: tab.viewMode,
      profile,
      diskMtime: tab.diskMtime,
      nextMtime: mtime,
    })
    if (beforeRead === 'ignore') return 'ignored'

    if (beforeRead === 'notify-view') {
      deps.setDiskMtime(tab.id, mtime)
      deps.notifyViewChanged(tab)
      return 'notify-view'
    }

    const encoding = await deps.resolveEncoding(tab)
    const diskContent = await deps.readFile(tab.path, encoding)
    // After awaits: tab may be closed, or the user may have started typing.
    const fresh = deps.resolveTab(tab.id)
    if (!fresh || shouldSkipOpenFileSync(fresh)) return 'skipped'
    const local = deps.getLocalContent(fresh)
    const afterRead = decideExternalChangeAfterRead({
      dirty: fresh.dirty,
      localContent: local,
      diskContent,
    })

    if (afterRead === 'update-mtime') {
      deps.setDiskMtime(fresh.id, mtime)
      return 'update-mtime'
    }

    if (afterRead === 'reload') {
      await deps.reloadFromDisk(fresh.id, diskContent, mtime)
      return 'reloaded'
    }

    const allowCompare = (fresh.fileSize ?? 0) <= editMaxBytes
    const choice = await deps.promptConflict({ tab: fresh, allowCompare })
    if (choice === 'reload') {
      await deps.reloadFromDisk(fresh.id, diskContent, mtime)
      return 'prompted-reload'
    }
    if (choice === 'keep') {
      deps.setDiskMtime(fresh.id, mtime)
      return 'prompted-keep'
    }
    if (choice === 'compare' && allowCompare) {
      deps.flushLive(fresh.id)
      const localNow = deps.getLocalContent(fresh)
      deps.openCompare({
        tab: fresh,
        localContent: localNow,
        diskContent,
        mtime,
      })
      return 'prompted-compare'
    }
    return 'prompted-dismiss'
  } finally {
    syncingPaths.delete(key)
  }
}

export function findOpenTabByPath(
  tabs: EditorTab[],
  projectSessions: Record<string, { tabs: EditorTab[] }>,
  path: string,
): EditorTab | undefined {
  const current = tabs.find(t => pathsEqual(t.path, path))
  if (current) return current
  for (const session of Object.values(projectSessions)) {
    const tab = session.tabs.find(t => pathsEqual(t.path, path))
    if (tab) return tab
  }
  return undefined
}

export function collectSyncableOpenTabs(
  tabs: EditorTab[],
  projectSessions: Record<string, { tabs: EditorTab[] }>,
): EditorTab[] {
  const byPath = new Map<string, EditorTab>()
  const consider = (tab: EditorTab) => {
    if (shouldSkipOpenFileSync(tab)) return
    const key = normalizePathKey(tab.path)
    if (!byPath.has(key)) byPath.set(key, tab)
  }
  for (const tab of tabs) consider(tab)
  for (const session of Object.values(projectSessions)) {
    for (const tab of session.tabs) consider(tab)
  }
  return [...byPath.values()]
}

/**
 * Focus / visibility catch-up: only proceed when mtime differs (cheap probe),
 * then run the full sync for candidates that actually changed.
 */
export async function syncOpenFilesOnFocus(
  tabs: EditorTab[],
  deps: SyncOpenFileDeps & {
    listTabs: () => EditorTab[]
  },
): Promise<SyncOpenFileOutcome[]> {
  const outcomes: SyncOpenFileOutcome[] = []
  for (const tab of tabs) {
    if (shouldSkipOpenFileSync(tab)) {
      outcomes.push('skipped')
      continue
    }
    let nextMtime: number | null
    try {
      nextMtime = await deps.fileMtime(tab.path)
    } catch {
      outcomes.push('skipped')
      continue
    }
    const unchanged =
      nextMtime != null && tab.diskMtime != null && nextMtime === tab.diskMtime
    if (unchanged) {
      outcomes.push('ignored')
      continue
    }
    // Re-resolve the tab in case the user switched / closed it during the probe.
    const fresh = deps.listTabs().find(t => t.id === tab.id)
    if (!fresh || shouldSkipOpenFileSync(fresh)) {
      outcomes.push('skipped')
      continue
    }
    outcomes.push(await syncOpenFileFromDisk(fresh, deps))
  }
  return outcomes
}
