import type { EditorTab } from '../types'
import { flushAutoSave, shouldAutoSaveBeforeDiscard } from '../lib/autoSave'
import { confirmDialog } from '../store/confirmStore'
import { translate } from '../lib/i18n'

export async function confirmDiscardTabs(tabs: EditorTab[], action: string) {
  if (shouldAutoSaveBeforeDiscard()) {
    await flushAutoSave(tabs.filter(tab => tab.dirty).map(tab => tab.id))
  }
  const dirtyTabs = tabs.filter(tab => tab.dirty)
  if (dirtyTabs.length === 0) return true

  const names = dirtyTabs.slice(0, 3).map(tab => `「${tab.name}」`).join('、')
  const remainder = dirtyTabs.length > 3 ? translate(' 等 {count} 个文件', { count: dirtyTabs.length }) : ''
  return confirmDialog({
    title: translate('未保存的更改'),
    message: translate('{names}{remainder} 尚未保存', { names, remainder }),
    detail: translate('{action}会丢失这些更改，且无法撤销。', { action: translate(action) }),
    kind: 'warning',
    confirmLabel: translate('放弃更改'),
    cancelLabel: translate('取消'),
  })
}
