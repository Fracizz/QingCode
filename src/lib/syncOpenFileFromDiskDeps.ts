import { safeInvoke } from './tauri'
import { flushLiveEditorContent, getLiveEditorContent } from './editorSession'
import { getEditorPreferences } from './editorSettings'
import { resolveReadEncoding } from './fileEncoding'
import { translate } from './i18n'
import type { EditorTab } from '../types'
import type { SyncOpenFileDeps } from './syncOpenFileFromDisk'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useCompareStore } from '../store/compareStore'
import { choiceDialog } from '../store/choiceStore'

function resolveOpenTab(id: string): EditorTab | undefined {
  const editor = useEditorStore.getState()
  const current = editor.tabs.find(t => t.id === id)
  if (current) return current
  for (const session of Object.values(editor.projectSessions)) {
    const tab = session.tabs.find(t => t.id === id)
    if (tab) return tab
  }
  return undefined
}

/** Production deps wiring syncOpenFileFromDisk to Tauri + Zustand stores. */
export function createDefaultSyncOpenFileDeps(): SyncOpenFileDeps {
  return {
    isSuppressed: path =>
      safeInvoke<boolean>('检查监视抑制', 'is_fs_watch_suppressed', { path }),
    fileMtime: path =>
      safeInvoke<number | null>('读取修改时间', 'file_mtime', { path }),
    readFile: (path, encoding) =>
      safeInvoke<string>('读取文件', 'read_file', { path, encoding }),
    resolveEncoding: async tab =>
      tab.encoding ??
      (await resolveReadEncoding(tab.path, getEditorPreferences().encoding)),
    resolveTab: resolveOpenTab,
    getLocalContent: tab => getLiveEditorContent(tab.id) ?? tab.content ?? '',
    setDiskMtime: (id, mtime) => useEditorStore.getState().setDiskMtime(id, mtime),
    reloadFromDisk: (id, content, mtime) =>
      useEditorStore.getState().reloadFromDisk(id, content, mtime),
    notifyViewChanged: tab => {
      useProjectStore
        .getState()
        .pushToast('info', translate('磁盘文件已更改（只读预览）：{name}', { name: tab.name }))
    },
    notifyReloaded: tab => {
      useProjectStore
        .getState()
        .pushToast('info', translate('已重新加载外部更改：{name}', { name: tab.name }))
    },
    promptConflict: async ({ tab, allowCompare }) => {
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
      if (choice === 'reload' || choice === 'keep' || choice === 'compare') return choice
      return null
    },
    openCompare: ({ tab, localContent, diskContent, mtime }) => {
      const editor = useEditorStore.getState()
      const close = () => useCompareStore.getState().closeCompare()
      useCompareStore.getState().openCompare({
        path: tab.path,
        leftTitle: translate('本地修改'),
        rightTitle: translate('磁盘版本'),
        leftContent: localContent,
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
    },
    flushLive: tabId => flushLiveEditorContent(tabId),
  }
}
