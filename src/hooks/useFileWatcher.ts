import { hasBackend } from '../lib/runtimeCapabilities'
import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isSshResource, safeInvoke } from '../lib/tauri'
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
import { findProjectForPath, isDescendantOf, pathsEqual } from '../utils/fileReferences'
import { shouldSkipWatcherTreeRefresh } from '../lib/watcherTreeRefresh'
import { createWatcherTreeRefreshQueue } from '../lib/watcherTreeRefreshQueue'
import type { EditorTab, Project } from '../types'
import { recordPerformanceThroughput } from '../lib/performanceDiagnostics'
import {
  getGitRefreshIntervalStartMinutes,
  GIT_REFRESH_INTERVAL_START_EVENT,
} from '../lib/gitRefreshSettings'
import { projectGitRefreshDelay } from '../lib/projectIndicators'
import { createFileWatchSync, type FileWatchTargets } from '../lib/fileWatchSync'

export type FsChangePayload = {
  path: string
  kind: string
  isDir: boolean
}

/** Per-path debounce for rapid external writes before content sync. */
const CONTENT_SYNC_DEBOUNCE_MS = 350

/** SSH 项目窗口聚焦时的 Git 刷新冷却：一次刷新 = 一次远程 git status。 */
const SSH_GIT_FOCUS_COOLDOWN_MS = 60_000

/**
 * 本地项目窗口聚焦时的 Git 刷新冷却。
 *
 * 本地一次刷新虽然只是一个子进程，但 `git status -uall` 在大仓库上要 0.3–0.6 秒；
 * Alt-Tab 来回切时不该每 1.5 秒就重新扫一遍工作区。
 */
const LOCAL_GIT_FOCUS_COOLDOWN_MS = 2_000

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

async function refreshTreesForPaths(paths: string[]) {
  const store = useProjectStore.getState()
  const projects = new Map<string, Project>()
  for (const path of paths) {
    const project =
      findProjectForPath(store.projects, path) ??
      (store.currentProject && isDescendantOf(path, store.currentProject.path)
        ? store.currentProject
        : null)
    if (!project || project.ephemeral || projects.has(project.id)) continue
    if (await shouldSkipWatcherTreeRefresh(path, project)) continue
    projects.set(project.id, project)
  }
  // One root reload also scans every loaded descendant. This covers all parents
  // in a large batch and avoids scanning directories that have already vanished.
  await Promise.all([...projects.values()].map(project => store.refreshProjectTree(project)))
}

function collectWatchRoots(currentProject: Project | null): string[] {
  if (currentProject && !currentProject.ephemeral) {
    return isSshResource(currentProject.path) ? [] : [currentProject.path]
  }
  return []
}

function collectWatchFiles(
  tabs: EditorTab[],
  projectSessions: Record<string, { tabs: EditorTab[] }>
): string[] {
  const files = new Set<string>()
  for (const tab of tabs) {
    if (!tab.loading && !tab.openError && !isSshResource(tab.path)) files.add(tab.path)
  }
  for (const session of Object.values(projectSessions)) {
    for (const tab of session.tabs) {
      if (!tab.loading && !tab.openError && !isSshResource(tab.path)) files.add(tab.path)
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
  const treeQueueRef = useRef<ReturnType<typeof createWatcherTreeRefreshQueue> | null>(null)
  const gitEventTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const depsRef = useRef(createDefaultSyncOpenFileDeps())
  const watchSyncRef = useRef<ReturnType<typeof createFileWatchSync> | null>(null)

  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const projectSessions = useEditorStore(s => s.projectSessions)
  const activeTabId = useEditorStore(s => s.activeTabId)
  // Buffer edits, tab metadata and project object replacements do not change
  // the native watch set. Sorting also makes tab reordering a no-op.
  const watchTargetsKey = JSON.stringify({
    roots: collectWatchRoots(currentProject).sort(),
    files: collectWatchFiles(tabs, projectSessions).sort(),
  })
  const [gitRefreshIntervalStartMinutes, setGitRefreshIntervalStartMinutes] = useState(
    getGitRefreshIntervalStartMinutes
  )

  useEffect(() => {
    const sync = () => setGitRefreshIntervalStartMinutes(getGitRefreshIntervalStartMinutes())
    window.addEventListener(GIT_REFRESH_INTERVAL_START_EVENT, sync)
    queueMicrotask(sync)
    return () => window.removeEventListener(GIT_REFRESH_INTERVAL_START_EVENT, sync)
  }, [])

  // Recursively watch only the active project. Inactive-project tabs are watched as files.
  useEffect(() => {
    if (!hasBackend()) return
    const sync = createFileWatchSync(
      ({ roots, files }) => safeInvoke('同步文件监视', 'sync_file_watches', { roots, files }),
      error => console.error('sync_file_watches failed:', error),
    )
    watchSyncRef.current = sync
    return () => {
      sync.dispose()
      if (watchSyncRef.current === sync) watchSyncRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!hasBackend()) return
    const targets = JSON.parse(watchTargetsKey) as FileWatchTargets
    const timer = window.setTimeout(() => watchSyncRef.current?.request(targets), 100)
    return () => window.clearTimeout(timer)
  }, [watchTargetsKey])

  // Lightweight git dirty snapshot for the current project.
  useEffect(() => {
    if (!hasBackend() || !currentProject || currentProject.ephemeral) {
      useGitStatusStore.getState().clear()
      return
    }
    void useGitStatusStore.getState().refresh(currentProject.path, { reuseInFlight: true })
    // SSH 每次刷新都是一次远程往返，本地是一次全量 status：都不该被 Alt-Tab 连刷拉起。
    const focusCooldownMs = isSshResource(currentProject.path)
      ? SSH_GIT_FOCUS_COOLDOWN_MS
      : LOCAL_GIT_FOCUS_COOLDOWN_MS
    // 上一行刚刷新过一次，冷却从这里起算。
    let lastFocusRefreshAt = Date.now()
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusRefreshAt < focusCooldownMs) return
      lastFocusRefreshAt = now
      useGitStatusStore.getState().scheduleRefresh(currentProject.path, 200)
    }
    window.addEventListener('focus', onFocus)
    let refreshTimer: number | null = null
    const scheduleRefresh = () => {
      refreshTimer = window.setTimeout(() => {
        useGitStatusStore.getState().scheduleRefresh(currentProject.path, 0)
        scheduleRefresh()
      }, projectGitRefreshDelay(gitRefreshIntervalStartMinutes))
    }
    scheduleRefresh()
    return () => {
      window.removeEventListener('focus', onFocus)
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [currentProject, gitRefreshIntervalStartMinutes])

  // Catch missed OS events: window focus / becoming visible again.
  useEffect(() => {
    if (!hasBackend()) return
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
      const current = useProjectStore.getState().currentProject
      if (current && !current.ephemeral && !isSshResource(current.path)) {
        treeQueueRef.current?.enqueue(current.path)
        // Re-register in case the OS watcher missed registration or lost its root.
        const editor = useEditorStore.getState()
        watchSyncRef.current?.request({
          roots: collectWatchRoots(current).sort(),
          files: collectWatchFiles(editor.tabs, editor.projectSessions).sort(),
        }, true)
      }
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
    if (!hasBackend() || !activeTabId) return
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
    if (!hasBackend()) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    const deps = depsRef.current
    const contentSyncTimers = contentTimers.current
    const treeQueue = createWatcherTreeRefreshQueue(async paths => {
      await refreshTreesForPaths(paths)
      useGitStatusStore.getState().scheduleRefresh(undefined, 700)
    }, error => console.error('fs-change tree refresh failed:', error))
    treeQueueRef.current = treeQueue

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
      treeQueue.enqueue(changedPath)

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
      treeQueue.dispose()
      if (treeQueueRef.current === treeQueue) treeQueueRef.current = null
      if (gitEventTimer.current) clearTimeout(gitEventTimer.current)
      for (const timer of contentSyncTimers.values()) clearTimeout(timer)
      contentSyncTimers.clear()
    }
  }, [])
}
