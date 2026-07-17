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
 * 「格式化失败」 wrapper.
 */
export function formatDocumentErrorToast(error: unknown): string {
  const message = formatInvokeErrorMessage(error)
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
    return message
  }
  return translate('格式化失败: {error}', { error: message })
}

/** Format the active (or given) editor tab via native formatters. */
export async function formatDocument(tabId?: string): Promise<void> {
  const editor = useEditorStore.getState()
  const id = tabId ?? editor.activeTabId
  if (!id) {
    useProjectStore.getState().pushToast('error', translate('没有可格式化的文件'))
    return
  }

  const tab = editor.findTab(id)
  if (!tab) {
    useProjectStore.getState().pushToast('error', translate('没有可格式化的文件'))
    return
  }

  if (isPinnedSettingsTab(tab.path) || tab.viewMode === 'view' || tab.loading || tab.openError) {
    useProjectStore.getState().pushToast('error', translate('当前标签不支持格式化'))
    return
  }

  const content = getLiveEditorContent(id) ?? tab.content
  if (content === undefined) {
    useProjectStore.getState().pushToast('error', translate('当前标签不支持格式化'))
    return
  }

  if (content.length > EDIT_DEGRADED_BYTES) {
    useProjectStore.getState().pushToast(
      'error',
      translate('文件过大（>{size}），无法在编辑器内格式化', {
        size: formatFileSize(EDIT_DEGRADED_BYTES),
      }),
    )
    return
  }

  try {
    const formatted = await safeInvoke<string>('格式化文档', 'format_document', {
      path: tab.path,
      content,
    })
    if (formatted === content) {
      useProjectStore.getState().pushToast('success', translate('已是格式化结果'))
      return
    }
    const changed = applyEditorDocument(id, formatted)
    if (changed) {
      useProjectStore.getState().pushToast('success', translate('已格式化'))
    }
  } catch (error) {
    useProjectStore.getState().pushToast('error', formatDocumentErrorToast(error))
  }
}
