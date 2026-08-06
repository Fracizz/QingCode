import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { createDefaultSyncOpenFileDeps } from '../lib/syncOpenFileFromDiskDeps'
import {
  collectSyncableOpenTabs,
  findOpenTabByPath,
  syncOpenFileFromDisk,
  syncOpenFilesOnFocus,
} from '../lib/syncOpenFileFromDisk'
import { findProjectForPath, isDescendantOf, parentPath, pathsEqual } from '../utils/fileReferences'
import { shouldSkipWatcherTreeRefresh } from '../lib/watcherTreeRefresh'
import type { EditorTab, Project } from '../types'
import { recordPerformanceThroughput } from '../lib/performanceDiagnostics'

export type FsChangePayload = {
  path: string
  kind: string
  isDir: boolean
}

/** Per-path debounce for rapid external writes before content sync. */
const CONTENT_SYNC_DEBOUNCE_MS = 350

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

async function syncWatches(roots: string[], files: string[]) {
  if (!isTauri()) return
  try {
    await safeInvoke('同步文件监视', 'sync_file_watches', { roots, files })
  } catch (e) {
    console.error('sync_file_watches failed:', e)
  }
}

async function refreshTreeForPath(path: string) {
  const store = useProjectStore.getState()
  const project =
    findProjectForPath(store.projects, path) ??
    (store.currentProject && isDescendantOf(path, store.currentProject.path)
      ? store.currentProject
      : null)
  if (!project || project.ephemeral) return
  if (await shouldSkipWatcherTreeRefresh(path, project)) return

  // Always refresh the *parent* listing. Expanding the changed path itself is wrong when
  // the event is a short-lived directory that has already been deleted (Cargo deps temps).
  const changed = path.replace(/[/\\]+$/, '')
  const dir = pathsEqual(changed, project.path) ? project.path : parentPath(changed)
  if (pathsEqual(dir, project.path) || pathsEqual(changed, project.path)) {
    await store.refreshProjectTree(project)
  } else {
    await store.expandProjectDir(project.id, dir, { force: true })
  }
}

function collectWatchRoots(
  currentProject: Project | null
): string[] {
  if (currentProject && !currentProject.ephemeral) {
    return [currentProject.path]
  }
  return []
}

function collectWatchFiles(
  tabs: EditorTab[],
  projectSessions: Record<string, { tabs: EditorTab[] }>
): string[] {
  const files = new Set<string>()
  for (const tab of tabs) {
    if (!tab.loading && !tab.openError) files.add(tab.path)
  }
  for (const session of Object.values(projectSessions)) {
    for (const tab of session.tabs) {
      if (!tab.loading && !tab.openError) files.add(tab.path)
    }
  }
  return [...files]
}

function listAllOpenTabs(): EditorTab[] {
  const editor = useEditorStore.getState()
  return collectSyncableOpenTabs(editor.tabs, editor.projectSessions)
}

function scheduleContentSync(
  path: string,
  timers: Map<string, ReturnType<typeof setTimeout>>,
  run: (path: string) => void
) {
  const key = normalize(path)
  const existing = timers.get(key)
  if (existing) clearTimeout(existing)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      run(path)
    }, CONTENT_SYNC_DEBOUNCE_MS)
  )
}

export function useFileWatcher() {
  const treeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTreePaths = useRef(new Map<string, string>())
  const gitEventTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const depsRef = useRef(createDefaultSyncOpenFileDeps())

  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const projectSessions = useEditorStore(s => s.projectSessions)
  const activeTabId = useEditorStore(s => s.activeTabId)

  // Recursively watch only the active project. Inactive-project tabs are watched as files.
  useEffect(() => {
    if (!isTauri()) return
    const roots = collectWatchRoots(currentProject)
    const files = collectWatchFiles(tabs, projectSessions)
    const timer = window.setTimeout(() => void syncWatches(roots, files), 100)
    return () => window.clearTimeout(timer)
  }, [currentProject, tabs, projectSessions])

  // Lightweight git dirty snapshot for the current project.
  useEffect(() => {
    if (!isTauri() || !currentProject || currentProject.ephemeral) {
      useGitStatusStore.getState().clear()
      return
    }
    void useGitStatusStore.getState().refresh(currentProject.path)
    const onFocus = () => useGitStatusStore.getState().scheduleRefresh(currentProject.path, 200)
    window.addEventListener('focus', onFocus)
    const intervalId = window.setInterval(() => {
      useGitStatusStore.getState().scheduleRefresh(currentProject.path, 0)
    }, 30_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(intervalId)
    }
  }, [currentProject])

  // Catch missed OS events: window focus / becoming visible again.
  useEffect(() => {
    if (!isTauri()) return
    let focusTimer: ReturnType<typeof setTimeout> | null = null

    const runFocusSync = () => {
      if (document.visibilityState === 'hidden') return
      const deps = {
        ...depsRef.current,
        listTabs: listAllOpenTabs,
      }
      void syncOpenFilesOnFocus(listAllOpenTabs(), deps).catch(e => {
        console.error('focus open-file sync failed:', e)
      })
    }

    const onFocus = () => {
      if (focusTimer) clearTimeout(focusTimer)
      // Short delay so suppress windows from a just-finished save can expire.
      focusTimer = setTimeout(runFocusSync, 200)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onFocus()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (focusTimer) clearTimeout(focusTimer)
    }
  }, [])

  // Activating a tab: cheap mtime check for that file only.
  useEffect(() => {
    if (!isTauri() || !activeTabId) return
    const tab = useEditorStore.getState().tabs.find(t => t.id === activeTabId)
    if (!tab || tab.kind === 'diff') return
    const deps = {
      ...depsRef.current,
      listTabs: listAllOpenTabs,
    }
    void syncOpenFilesOnFocus([tab], deps).catch(e => {
      console.error('activate-tab open-file sync failed:', e)
    })
  }, [activeTabId])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    const deps = depsRef.current
    const contentSyncTimers = contentTimers.current

    const runPathContentSync = (changedPath: string) => {
      const editor = useEditorStore.getState()
      const tab = findOpenTabByPath(editor.tabs, editor.projectSessions, changedPath)
      if (!tab) return
      // Prefer a fresh tab snapshot at fire time.
      const fresh =
        editor.tabs.find(t => t.id === tab.id) ??
        Object.values(editor.projectSessions)
          .flatMap(s => s.tabs)
          .find(t => t.id === tab.id)
      if (!fresh) return
      void syncOpenFileFromDisk(fresh, deps).catch(e => {
        console.error('fs-change open-file sync failed:', e)
      })
    }

    void listen<FsChangePayload>('fs-change', event => {
      const payload = event.payload
      if (!payload?.path) return
      recordPerformanceThroughput('fsEvents')
      const changedPath = payload.path
      const current = useProjectStore.getState().currentProject
      if (
        current &&
        !current.ephemeral &&
        (pathsEqual(changedPath, current.path) || isDescendantOf(changedPath, current.path))
      ) {
        if (gitEventTimer.current) clearTimeout(gitEventTimer.current)
        gitEventTimer.current = setTimeout(() => {
          gitEventTimer.current = null
          window.dispatchEvent(
            new CustomEvent('qingcode:git-worktree-changed', {
              detail: { projectPath: current.path },
            })
          )
        }, 350)
      }

      // Debounced explorer refresh for project-tree churn.
      pendingTreePaths.current.set(normalize(changedPath), changedPath)
      if (treeTimer.current) clearTimeout(treeTimer.current)
      treeTimer.current = setTimeout(() => {
        const paths = [...pendingTreePaths.current.values()]
        pendingTreePaths.current.clear()
        treeTimer.current = null
        // Refresh once for the first few unique parents.
        const seen = new Set<string>()
        for (const p of paths) {
          const key = normalize(parentPath(p))
          if (seen.has(key)) continue
          seen.add(key)
          void refreshTreeForPath(p)
          if (seen.size >= 4) break
        }
        useGitStatusStore.getState().scheduleRefresh(undefined, 700)
      }, 500)

      const editor = useEditorStore.getState()
      const tab = findOpenTabByPath(editor.tabs, editor.projectSessions, changedPath)
      if (!tab) return
      scheduleContentSync(tab.path, contentSyncTimers, runPathContentSync)
    }).then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
      if (treeTimer.current) clearTimeout(treeTimer.current)
      if (gitEventTimer.current) clearTimeout(gitEventTimer.current)
      for (const timer of contentSyncTimers.values()) clearTimeout(timer)
      contentSyncTimers.clear()
    }
  }, [])
}
