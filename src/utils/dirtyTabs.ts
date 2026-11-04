import type { EditorTab } from '../types'
import { flushAutoSave, shouldAutoSaveBeforeDiscard } from '../lib/autoSave'
import { confirmDialog } from '../store/confirmStore'
import { translate } from '../lib/i18n'
import { useEditorStore } from '../store/editorStore'

type TranslateFn = (source: string, values?: Record<string, string | number>) => string

export function getDirtyTabs(tabs: EditorTab[]): EditorTab[] {
  return tabs.filter(tab => tab.dirty)
}

/** Build discard-confirmation copy for dirty tabs (pure; injectable translator for tests). */
export function formatDirtyDiscardCopy(
  dirtyTabs: EditorTab[],
  action: string,
  t: TranslateFn = translate,
) {
  const names = dirtyTabs.slice(0, 3).map(tab => `「${tab.name}」`).join('、')
  const remainder = dirtyTabs.length > 3 ? t(' 等 {count} 个文件', { count: dirtyTabs.length }) : ''
  return {
    title: t('未保存的更改'),
    message: t('{names}{remainder} 尚未保存', { names, remainder }),
    detail: t('{action}会丢失这些更改，且无法撤销。', { action: t(action) }),
    confirmLabel: t('放弃更改'),
    cancelLabel: t('取消'),
  }
}

export async function confirmDiscardTabs(tabs: EditorTab[], action: string) {
  const currentTabs = () => tabs.map(tab => useEditorStore.getState().findTab(tab.id) ?? tab)
  if (shouldAutoSaveBeforeDiscard()) {
    await flushAutoSave(getDirtyTabs(tabs).map(tab => tab.id))
  }
  const dirtyTabs = getDirtyTabs(currentTabs())
  if (dirtyTabs.length === 0) return true

  const copy = formatDirtyDiscardCopy(dirtyTabs, action)
  const decision = await confirmDialog({
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    kind: 'warning',
    confirmLabel: translate(action === '关闭文件' ? '保存并关闭' : '保存并继续'),
    altLabel: copy.confirmLabel,
    cancelLabel: copy.cancelLabel,
  })
  if (decision === 'alt') return true
  if (!decision) return false
  try {
    for (const tab of dirtyTabs) {
      await useEditorStore.getState().saveFile(tab.id)
      // saveFile reports failures itself, including conflicts and cancelled writes.
      if (useEditorStore.getState().findTab(tab.id)?.dirty !== false) return false
    }
    return getDirtyTabs(currentTabs()).length === 0
  } catch {
    return false
  }
}
