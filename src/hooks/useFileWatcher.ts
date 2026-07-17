import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { choiceDialog } from '../store/choiceStore'
import { flushLiveEditorContent, getLiveEditorContent } from '../lib/editorSession'
import { translate } from '../lib/i18n'
import { findProjectForPath, isDescendantOf, parentPath, pathsEqual } from '../utils/fileReferences'
import type { FileCompareRequest } from '../components/FileCompareDialog'

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

export function useFileWatcher() {
  const [compare, setCompare] = useState<FileCompareRequest | null>(null)
  const prompting = useRef(new Set<string>())
  const treeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTreePaths = useRef<string[]>([])

  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)

  // Sync OS watches with open files + current project root.
  useEffect(() => {
    if (!isTauri()) return
    const roots = currentProject && !currentProject.ephemeral ? [currentProject.path] : []
    const files = tabs
      .filter(t => !t.loading && !t.openError)
      .map(t => t.path)
    void syncWatches(roots, files)
  }, [currentProject?.path, currentProject?.ephemeral, tabs])

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
      const tab = editor.tabs.find(t => pathsEqual(t.path, changedPath))
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
          const diskContent = await safeInvoke<string>('读取文件', 'read_file', { path: tab.path })
          const mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', {
            path: tab.path,
          })
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

          // Dirty: ask user.
          const choice = await choiceDialog({
            title: '文件已在外部更改',
            message: '磁盘上的文件与本地未保存修改不一致。',
            detail: tab.path,
            options: [
              { id: 'reload', label: '重新加载', primary: true },
              { id: 'compare', label: '比较' },
              { id: 'keep', label: '保留本地修改' },
            ],
          })

          if (choice === 'reload') {
            await editor.reloadFromDisk(tab.id, diskContent, mtime)
          } else if (choice === 'keep') {
            editor.setDiskMtime(tab.id, mtime)
          } else if (choice === 'compare') {
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

