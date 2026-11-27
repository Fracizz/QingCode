// 编辑态纯逻辑：换行、dirty / 只读判定、标签状态迁移、冲突决策；不触碰 IO。

import { fileKind } from './fileLinks'
import type { Tab } from './filesModel'

export type Eol = '\n' | '\r\n'

/** 原文件换行风格按多数决定；CodeMirror 内部只用 \n，保存时还原。 */
export function detectEol(text: string): Eol {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    if (i > 0 && text[i - 1] === '\r') crlf++
    else lf++
  }
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

export function toEditorText(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function toDiskText(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
}

export function isDirty(tab: Pick<Tab, 'content' | 'savedText'>): boolean {
  return tab.content !== tab.savedText
}

export type ReadOnlyReason = 'binary' | 'image' | 'truncated' | 'diff' | null

/** 只读原因集中判定，UI 与保存入口共用，避免两处规则不一致。 */
export function readOnlyReason(tab: Pick<Tab, 'kind' | 'path' | 'binary' | 'truncated'>): ReadOnlyReason {
  if (tab.kind === 'diff') return 'diff'
  if (tab.binary) return 'binary'
  if (fileKind(tab.path) === 'image') return 'image'
  if (tab.truncated) return 'truncated'
  return null
}

export function readOnlyLabel(reason: ReadOnlyReason): string {
  switch (reason) {
    case 'binary':
      return '二进制文件只读'
    case 'image':
      return '图片只读'
    case 'truncated':
      return '大文件尚未完整加载，只读'
    case 'diff':
      return '差异视图只读'
    default:
      return ''
  }
}

/** 本地编辑只改 content；dirty 由 savedText 派生，刷新/保存不会误清。 */
export function applyLocalEdit(tab: Tab, text: string): Tab {
  if (tab.content === text) return tab
  const next: Tab = { ...tab, content: text, saveError: undefined }
  next.dirty = isDirty(next)
  return next
}

export function markSaving(tab: Tab): Tab {
  return { ...tab, saving: true, saveError: undefined }
}

/** writtenText 为本次真正写盘的文本；保存期间继续输入时 dirty 仍为 true。 */
export function markSaved(tab: Tab, mtimeMs: number, writtenText: string = tab.content): Tab {
  const next: Tab = {
    ...tab,
    savedText: writtenText,
    mtimeMs,
    saving: false,
    saveError: undefined,
    diskChanged: false,
  }
  next.dirty = isDirty(next)
  return next
}

export function markSaveFailed(tab: Tab, message: string): Tab {
  return { ...tab, saving: false, saveError: message }
}

/** 有未保存改动时文件在磁盘上又变了：只提示，不覆盖本地内容。 */
export function markDiskChanged(tab: Tab): Tab {
  return tab.diskChanged ? tab : { ...tab, diskChanged: true }
}

/** 重新加载：丢弃本地改动，用磁盘文本重建编辑器状态。 */
export function applyDiskText(tab: Tab, text: string, mtimeMs: number): Tab {
  const content = toEditorText(text)
  return {
    ...tab,
    content,
    savedText: content,
    eol: detectEol(text),
    mtimeMs,
    dirty: false,
    diskChanged: false,
    saving: false,
    saveError: undefined,
  }
}

export type FilePrompt =
  | { kind: 'conflict'; id: string; message: string; diskText?: string; diskMtimeMs?: number }
  | { kind: 'compare'; id: string; local: string; disk: string; diskMtimeMs?: number }
  | { kind: 'close'; ids: string[] }
  | { kind: 'refresh'; id: string }

export type ConflictAction = 'overwrite' | 'reload' | 'compare' | 'cancel'

export type ConflictContext = { local: string; eol: Eol; diskText?: string }

export type ConflictPlan =
  | { kind: 'overwrite'; content: string }
  | { kind: 'reload' }
  | { kind: 'compare'; local: string; disk: string }
  | { kind: 'cancel' }

/** 冲突对话框的四种决策转成可执行的计划，UI 不含业务判断。 */
export function planConflict(action: ConflictAction, ctx: ConflictContext): ConflictPlan {
  switch (action) {
    case 'overwrite':
      return { kind: 'overwrite', content: toDiskText(ctx.local, ctx.eol) }
    case 'reload':
      return { kind: 'reload' }
    case 'compare':
      return { kind: 'compare', local: ctx.local, disk: toEditorText(ctx.diskText ?? '') }
    case 'cancel':
      return { kind: 'cancel' }
  }
}
