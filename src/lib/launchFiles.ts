import { listen } from '@tauri-apps/api/event'
import { authorizePaths } from './pathAllowlist'
import { safeInvoke, isTauri } from './tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { translate } from './i18n'
import { parseOpenTarget } from './cliBridge'

async function openAuthorizedTargets(targets: string[]): Promise<void> {
  if (targets.length === 0) return
  const parsed = targets.map(parseOpenTarget)
  await authorizePaths(parsed.map(item => item.path))
  for (const item of parsed) {
    await useEditorStore.getState().openFile(item.path, item.line, item.column)
  }
}

/** Open paths from Explorer "Open with" / CLI after the UI is ready. */
export async function openLaunchFiles(): Promise<void> {
  if (!isTauri()) return
  try {
    const paths = await safeInvoke<string[]>('打开启动文件', 'take_launch_files')
    await openAuthorizedTargets(paths)
  } catch (e) {
    console.error('openLaunchFiles failed:', e)
    useProjectStore.getState().pushToast(
      'error',
      translate('打开文件失败: {error}', { error: String(e) }),
    )
  }
}

/** Listen for late single-instance requests and drain this window's native queue. */
export async function listenForOpenFileRequests(): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const unlisten = await listen('open-files', () => {
      void openLaunchFiles()
    })
    return unlisten
  } catch {
    return () => {}
  }
}
