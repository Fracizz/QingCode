import { useEffect, useRef } from 'react'
import { choiceDialog } from '../store/choiceStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import {
  clearDraft,
  listUnsavedDrafts,
  normalizeDraftPath,
  scheduleDraftPersist,
} from '../lib/draftRecovery'
import { flushAllLiveEditorContents, getLiveEditorContent } from '../lib/editorSession'
import { translate } from '../lib/i18n'

function collectOpenDraftPaths(): Set<string> {
  const paths = new Set<string>()
  const editor = useEditorStore.getState()
  for (const tab of editor.tabs) paths.add(normalizeDraftPath(tab.path))
  for (const session of Object.values(editor.projectSessions)) {
    for (const tab of session.tabs) paths.add(normalizeDraftPath(tab.path))
  }
  return paths
}

/** Persist dirty buffers and offer restore of crash drafts on startup. */
export function useDraftRecovery() {
  const tabs = useEditorStore(s => s.tabs)
  const started = useRef(false)

  // Debounced persist whenever dirty flags / tab set changes.
  useEffect(() => {
    if (!tabs.some(t => t.dirty)) return
    scheduleDraftPersist(
      () => {
        flushAllLiveEditorContents()
        return useEditorStore.getState().getAllTabs()
      },
      tabId => getLiveEditorContent(tabId),
    )
  }, [tabs])

  useEffect(() => {
    if (started.current) return
    started.current = true

    // Workspace session restore already applied drafts for restored dirty tabs.
    // Only prompt for orphan crash drafts that are not part of any open/session tab.
    const openPaths = collectOpenDraftPaths()
    const drafts = listUnsavedDrafts().filter(d => !openPaths.has(normalizeDraftPath(d.path)))
    if (drafts.length === 0) return

    void (async () => {
      const choice = await choiceDialog({
        title: '恢复未保存的草稿',
        message: translate('检测到 {count} 个未保存草稿（可能来自异常退出）。是否恢复？', {
          count: drafts.length,
        }),
        detail: drafts
          .slice(0, 8)
          .map(d => d.path)
          .join('\n'),
        options: [
          { id: 'restore', label: '恢复草稿', primary: true },
          { id: 'discard', label: '丢弃草稿', danger: true },
        ],
      })

      if (choice === 'discard') {
        for (const draft of drafts) clearDraft(draft.path)
        // Keep drafts that still belong to open/session tabs.
        return
      }
      if (choice !== 'restore') return

      const openFile = useEditorStore.getState().openFile
      for (const draft of drafts) {
        try {
          await openFile(draft.path)
          const tab = useEditorStore.getState().tabs.find(t => t.path === draft.path)
          if (!tab) continue
          useEditorStore.getState().setTabContent(tab.id, draft.content)
          useEditorStore.getState().markDirty(tab.id)
          useEditorStore.getState().bumpContentEpoch(tab.id)
          clearDraft(draft.path)
        } catch (e) {
          console.error('restore draft failed:', e)
          useProjectStore
            .getState()
            .pushToast('error', translate('恢复草稿失败: {error}', { error: String(e) }))
        }
      }
      useProjectStore
        .getState()
        .pushToast('success', translate('已恢复 {count} 个草稿', { count: drafts.length }))
    })()
  }, [])
}
