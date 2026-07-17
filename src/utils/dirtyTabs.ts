import type { EditorTab } from '../types'
import { flushAutoSave, shouldAutoSaveBeforeDiscard } from '../lib/autoSave'
import { confirmDialog } from '../store/confirmStore'
import { translate } from '../lib/i18n'

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
  if (shouldAutoSaveBeforeDiscard()) {
    await flushAutoSave(getDirtyTabs(tabs).map(tab => tab.id))
  }
  const dirtyTabs = getDirtyTabs(tabs)
  if (dirtyTabs.length === 0) return true

  const copy = formatDirtyDiscardCopy(dirtyTabs, action)
  return confirmDialog({
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    kind: 'warning',
    confirmLabel: copy.confirmLabel,
    cancelLabel: copy.cancelLabel,
  })
}
