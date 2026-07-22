import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useCompareStore } from '../store/compareStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { useSourceControlStore } from '../store/sourceControlStore'
import { choiceDialog } from '../store/choiceStore'
import { flushLiveEditorContent, getLiveEditorContent } from '../lib/editorSession'
import { getEditorPreferences } from '../lib/editorSettings'
import { resolveReadEncoding } from '../lib/fileEncoding'
import { editorPerfProfile, resolveEditMaxBytes } from '../lib/fileSizePolicy'
import {
  decideExternalChangeAfterRead,
  decideExternalChangeBeforeRead,
} from '../lib/externalFileChange'
import { translate } from '../lib/i18n'
import { findProjectForPath, isDescendantOf, parentPath, pathsEqual } from '../utils/fileReferences'
import { shouldSkipWatcherTreeRefresh } from '../lib/watcherTreeRefresh'
import type { EditorTab, Project } from '../types'

export type FsChangePayload = {
  path: string
  kind: string
  isDir: boolean
}

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
  currentProject: Project | null,
  projects: Project[],
  projectSessions: Record<string, { tabs: EditorTab[] }>,
): string[] {
  const roots = new Set<string>()
  if (currentProject && !currentProject.ephemeral) {
    roots.add(currentProject.path)
  }
  for (const [projectId, session] of Object.entries(projectSessions)) {
    if (session.tabs.length === 0) continue
    const project = projects.find(p => p.id === projectId)
    if (project && !project.ephemeral) roots.add(project.path)
  }
  return [...roots]
}

function collectWatchFiles(
  tabs: EditorTab[],
  projectSessions: Record<string, { tabs: EditorTab[] }>,
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

function findOpenTabByPath(path: string): EditorTab | undefined {
  const editor = useEditorStore.getState()
  const current = editor.tabs.find(t => pathsEqual(t.path, path))
  if (current) return current
  for (const session of Object.values(editor.projectSessions)) {
    const tab = session.tabs.find(t => pathsEqual(t.path, path))
    if (tab) return tab
  }
  return undefined
}

export function useFileWatcher() {
  const prompting = useRef(new Set<string>())
  const treeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTreePaths = useRef<string[]>([])

  const currentProject = useProjectStore(s => s.currentProject)
  const projects = useProjectStore(s => s.projects)
  const tabs = useEditorStore(s => s.tabs)
  const projectSessions = useEditorStore(s => s.projectSessions)

  // Watch current root + inactive projects that still have open tabs/files.
  useEffect(() => {
    if (!isTauri()) return
    const roots = collectWatchRoots(currentProject, projects, projectSessions)
    const files = collectWatchFiles(tabs, projectSessions)
    void syncWatches(roots, files)
  }, [currentProject, projects, tabs, projectSessions])

  // Lightweight git dirty snapshot for the current project.
  useEffect(() => {
    if (!isTauri() || !currentProject || currentProject.ephemeral) {
      useGitStatusStore.getState().clear()
      useSourceControlStore.getState().clearCache()
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

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false

    void listen<FsChangePayload>('fs-change', event => {
      const payload = event.payload
      if (!payload?.path) return
      const changedPath = payload.path
      const current = useProjectStore.getState().currentProject
      if (
        current &&
        !current.ephemeral &&
        (pathsEqual(changedPath, current.path) || isDescendantOf(changedPath, current.path))
      ) {
        window.dispatchEvent(
          new CustomEvent('qingcode:git-worktree-changed', {
            detail: { projectPath: current.path },
          }),
        )
      }

      // Debounced explorer refresh for project-tree churn.
      pendingTreePaths.current.push(changedPath)
      if (treeTimer.current) clearTimeout(treeTimer.current)
      treeTimer.current = setTimeout(() => {
        const paths = pendingTreePaths.current
        pendingTreePaths.current = []
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
      const tab = findOpenTabByPath(changedPath)
      if (!tab || tab.loading || tab.openError) return
      if (prompting.current.has(normalize(tab.path))) return

      void (async () => {
        try {
          const suppressed = await safeInvoke<boolean>('检查监视抑制', 'is_fs_watch_suppressed', {
            path: tab.path,
          })
          if (suppressed) return
        } catch {
          /* continue */
        }

        prompting.current.add(normalize(tab.path))
        try {
          const mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', {
            path: tab.path,
          })
          const editMaxBytes = resolveEditMaxBytes(tab.path)
          const profile = editorPerfProfile(tab.fileSize ?? 0, editMaxBytes)
          const beforeRead = decideExternalChangeBeforeRead({
            viewMode: tab.viewMode,
            profile,
            diskMtime: tab.diskMtime,
            nextMtime: mtime,
          })
          if (beforeRead === 'ignore') return
          // Read-only slice viewer: never pull full content into the WebView.
          if (beforeRead === 'notify-view') {
            editor.setDiskMtime(tab.id, mtime)
            useProjectStore
              .getState()
              .pushToast('info', translate('磁盘文件已更改（只读预览）：{name}', { name: tab.name }))
            return
          }

          const encoding = tab.encoding ?? await resolveReadEncoding(
            tab.path,
            getEditorPreferences().encoding,
          )
          const diskContent = await safeInvoke<string>('读取文件', 'read_file', {
            path: tab.path,
            encoding,
          })
          const local = getLiveEditorContent(tab.id) ?? tab.content ?? ''
          const afterRead = decideExternalChangeAfterRead({
            dirty: tab.dirty,
            localContent: local,
            diskContent,
          })

          if (afterRead === 'update-mtime') {
            editor.setDiskMtime(tab.id, mtime)
            return
          }

          if (afterRead === 'reload') {
            // Clean tab, external edit — reload quietly.
            await editor.reloadFromDisk(tab.id, diskContent, mtime)
            useProjectStore
              .getState()
              .pushToast('info', translate('已重新加载外部更改：{name}', { name: tab.name }))
            return
          }

          const allowCompare = (tab.fileSize ?? 0) <= editMaxBytes
          // Dirty: ask user.
          const choice = await choiceDialog({
            title: '文件已在外部更改',
            message: '磁盘上的文件与本地未保存修改不一致。',
            detail: tab.path,
            options: [
              { id: 'reload', label: '重新加载', primary: true },
              ...(allowCompare ? [{ id: 'compare', label: '比较' }] : []),
              { id: 'keep', label: '保留本地修改' },
            ],
          })

          if (choice === 'reload') {
            await editor.reloadFromDisk(tab.id, diskContent, mtime)
          } else if (choice === 'keep') {
            editor.setDiskMtime(tab.id, mtime)
          } else if (choice === 'compare' && allowCompare) {
            flushLiveEditorContent(tab.id)
            const localNow = getLiveEditorContent(tab.id) ?? tab.content ?? ''
            const close = () => useCompareStore.getState().closeCompare()
            useCompareStore.getState().openCompare({
              path: tab.path,
              leftTitle: translate('本地修改'),
              rightTitle: translate('磁盘版本'),
              leftContent: localNow,
              rightContent: diskContent,
              onClose: close,
              actions: [
                {
                  label: translate('保留本地修改'),
                  onClick: () => {
                    editor.setDiskMtime(tab.id, mtime)
                    close()
                  },
                },
                {
                  label: translate('重新加载'),
                  primary: true,
                  onClick: () => {
                    void editor.reloadFromDisk(tab.id, diskContent, mtime).then(close)
                  },
                },
              ],
            })
          }
        } catch (e) {
          console.error('fs-change handling failed:', e)
        } finally {
          prompting.current.delete(normalize(tab.path))
        }
      })()
    }).then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
      if (treeTimer.current) clearTimeout(treeTimer.current)
    }
  }, [])
}
