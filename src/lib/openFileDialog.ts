import { open } from '@tauri-apps/plugin-dialog'
import { translate } from './i18n'
import { getOpenWithStatus } from './openWithSettings'
import { authorizePaths } from './pathAllowlist'
import { isTauri } from './tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'

async function supportedExtensions(): Promise<string[]> {
  try {
    return (await getOpenWithStatus())?.extensions ?? []
  } catch (error) {
    console.warn('load supported file extensions failed:', error)
    return []
  }
}

/** Select one local file, authorize its path, and open it in the current editor session. */
export async function openFileFromDialog(): Promise<void> {
  const pushToast = useProjectStore.getState().pushToast
  if (!isTauri()) {
    pushToast('error', translate('当前环境无法打开文件'))
    return
  }

  try {
    const extensions = await supportedExtensions()
    const selected = await open({
      title: translate('打开文件'),
      directory: false,
      multiple: false,
      filters: [
        ...(extensions.length > 0
          ? [{ name: translate('代码和文本文件'), extensions }]
          : []),
        { name: translate('所有文件'), extensions: ['*'] },
      ],
    })
    if (!selected) return

    await authorizePaths([selected])
    await useEditorStore.getState().openFile(selected)
  } catch (error) {
    console.error('openFileFromDialog failed:', error)
    pushToast(
      'error',
      translate('打开文件失败: {error}', {
        error: String(error),
      })
    )
  }
}
