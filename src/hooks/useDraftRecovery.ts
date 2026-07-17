import { useEffect, useRef } from 'react'
import { choiceDialog } from '../store/choiceStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import {
  clearAllDrafts,
  clearDraft,
  listUnsavedDrafts,
  scheduleDraftPersist,
} from '../lib/draftRecovery'
import { flushAllLiveEditorContents, getLiveEditorContent } from '../lib/editorSession'
import { translate } from '../lib/i18n'

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
    const drafts = listUnsavedDrafts()
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
        clearAllDrafts()
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
