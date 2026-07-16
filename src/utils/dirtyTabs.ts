import type { EditorTab } from '../types'
import { confirmDialog } from '../store/confirmStore'

export async function confirmDiscardTabs(tabs: EditorTab[], action: string) {
  const dirtyTabs = tabs.filter(tab => tab.dirty)
  if (dirtyTabs.length === 0) return true

  const names = dirtyTabs.slice(0, 3).map(tab => `「${tab.name}」`).join('、')
  const remainder = dirtyTabs.length > 3 ? ` 等 ${dirtyTabs.length} 个文件` : ''
  return confirmDialog({
    title: '未保存的更改',
    message: `${names}${remainder} 尚未保存`,
    detail: `${action}会丢失这些更改，且无法撤销。`,
    kind: 'warning',
    confirmLabel: '放弃更改',
    cancelLabel: '取消',
  })
}
