import { safeInvoke } from './tauri'
import {
  applyEditorDocument,
  getLiveEditorContent,
} from './editorSession'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { translate } from './i18n'
import { isPinnedSettingsTab } from '../utils/editorHelpers'
import { EDIT_DEGRADED_BYTES, formatFileSize } from './fileSizePolicy'

/** Normalize Tauri / Error payloads into a plain message string. */
export function formatInvokeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error:\s*/i, '').trim() || raw
}

/**
 * Prefer clear backend messages (暂不支持 / 未找到 …) over a vague
 * 「格式化失败」 wrapper. Backend strings use Chinese source keys for i18n.
 */
export function formatDocumentErrorToast(error: unknown): string {
  const message = formatInvokeErrorMessage(error)

  const unsupportedExt = message.match(/^暂不支持格式化该语言\/扩展名（\.(.+?)）$/)
  if (unsupportedExt) {
    return translate('暂不支持格式化该语言/扩展名（.{ext}）', { ext: unsupportedExt[1] })
  }

  if (
    message.includes('暂不支持')
    || message.startsWith('未找到')
    || message.startsWith('格式化失败')
    || message.startsWith('格式化超时')
    || message.startsWith('文件过大')
    || message.startsWith('无法识别')
    || message.startsWith('无法启动')
    || message.startsWith('写入格式化')
    || message.startsWith('格式化进程')
    || message.startsWith('格式化输出')
  ) {
    return translate(message)
  }
  return translate('格式化失败: {error}', { error: message })
}

export type FormatDocumentOptions = {
  /**
   * Suppress success / already-formatted / unsupported / too-large toasts.
   * Used by format-on-save so routine saves stay quiet; tool-missing still surfaces.
   */
  quiet?: boolean
}

/** Format the active (or given) editor tab via native formatters. */
export async function formatDocument(
  tabId?: string,
  options: FormatDocumentOptions = {},
): Promise<void> {
  const quiet = options.quiet === true
  const toast = (level: 'success' | 'error' | 'info', message: string) => {
    if (quiet && level !== 'error') return
    useProjectStore.getState().pushToast(level, message)
  }

  const editor = useEditorStore.getState()
  const id = tabId ?? editor.activeTabId
  if (!id) {
    toast('error', translate('没有可格式化的文件'))
    return
  }

  const tab = editor.findTab(id)
  if (!tab) {
    toast('error', translate('没有可格式化的文件'))
    return
  }

  if (isPinnedSettingsTab(tab.path) || tab.viewMode === 'view' || tab.loading || tab.openError) {
    if (!quiet) toast('error', translate('当前标签不支持格式化'))
    return
  }

  const content = getLiveEditorContent(id) ?? tab.content
  if (content === undefined) {
    if (!quiet) toast('error', translate('当前标签不支持格式化'))
    return
  }

  if (content.length > EDIT_DEGRADED_BYTES) {
    if (!quiet) {
      toast(
        'error',
        translate('文件过大（>{size}），无法在编辑器内格式化', {
          size: formatFileSize(EDIT_DEGRADED_BYTES),
        }),
      )
    }
    return
  }

  try {
    const formatted = await safeInvoke<string>('格式化文档', 'format_document', {
      path: tab.path,
      content,
    })
    if (formatted === content) {
      toast('success', translate('已是格式化结果'))
      return
    }
    const changed = applyEditorDocument(id, formatted)
    if (changed) {
      toast('success', translate('已格式化'))
    }
  } catch (error) {
    const message = formatDocumentErrorToast(error)
    // Quiet save path: skip "unsupported language" noise; still surface missing tools.
    if (quiet && message.includes('暂不支持')) return
    toast('error', message)
  }
}
