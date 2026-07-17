import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { choiceDialog } from '../store/choiceStore'
import { flushLiveEditorContent, getLiveEditorContent } from '../lib/editorSession'
import { EDIT_MAX_BYTES, editorPerfProfile } from '../lib/fileSizePolicy'
import { translate } from '../lib/i18n'
import { findProjectForPath, isDescendantOf, parentPath, pathsEqual } from '../utils/fileReferences'
import type { FileCompareRequest } from '../components/FileCompareDialog'
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
  const dir = path.endsWith('/') || path.endsWith('\\') ? path.replace(/[/\\]+$/, '') : parentPath(path)
  if (pathsEqual(dir, project.path) || pathsEqual(path, project.path)) {
    await store.refreshProjectTree(project)
  } else {
    await store.expandProjectDir(project.id, dir)
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
  const [compare, setCompare] = useState<FileCompareRequest | null>(null)
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

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false

    void listen<FsChangePayload>('fs-change', event => {
      const payload = event.payload
      if (!payload?.path) return
      const changedPath = payload.path

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

          // Read-only slice viewer: never pull full content into the WebView.
          if (tab.viewMode === 'view') {
            if (mtime != null && mtime === tab.diskMtime) return
            editor.setDiskMtime(tab.id, mtime)
            useProjectStore
              .getState()
              .pushToast('info', translate('磁盘文件已更改（只读预览）：{name}', { name: tab.name }))
            return
          }

          const profile = editorPerfProfile(tab.fileSize ?? 0)
          // Plain/degraded: skip full read when mtime is unchanged.
          if (
            (profile === 'plain' || profile === 'degraded') &&
            mtime != null &&
            tab.diskMtime != null &&
            mtime === tab.diskMtime
          ) {
            return
          }

          const diskContent = await safeInvoke<string>('读取文件', 'read_file', { path: tab.path })
          const local = getLiveEditorContent(tab.id) ?? tab.content ?? ''

          if (!tab.dirty && local === diskContent) {
            editor.setDiskMtime(tab.id, mtime)
            return
          }

          if (!tab.dirty && local !== diskContent) {
            // Clean tab, external edit — reload quietly.
            await editor.reloadFromDisk(tab.id, diskContent, mtime)
            useProjectStore
              .getState()
              .pushToast('info', translate('已重新加载外部更改：{name}', { name: tab.name }))
            return
          }

          const allowCompare = (tab.fileSize ?? 0) <= EDIT_MAX_BYTES
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
            setCompare({
              path: tab.path,
              localContent: localNow,
              diskContent,
              onClose: () => setCompare(null),
              onKeepLocal: () => {
                editor.setDiskMtime(tab.id, mtime)
                setCompare(null)
              },
              onReload: () => {
                void editor.reloadFromDisk(tab.id, diskContent, mtime).then(() => setCompare(null))
              },
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

  return { compare }
}
