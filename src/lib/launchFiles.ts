import { listen } from '@tauri-apps/api/event'
import { authorizePaths } from './pathAllowlist'
import { safeInvoke, isTauri } from './tauri'
import { useEditorStore } from '../store/editorStore'

async function openAuthorizedPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await authorizePaths(paths)
  for (const path of paths) {
    await useEditorStore.getState().openFile(path)
  }
}

/** Open paths from Explorer "Open with" / CLI after the UI is ready. */
export async function openLaunchFiles(): Promise<void> {
  if (!isTauri()) return
  try {
    const paths = await safeInvoke<string[]>('打开启动文件', 'take_launch_files')
    await openAuthorizedPaths(paths)
  } catch (e) {
    console.error('openLaunchFiles failed:', e)
  }
}

/** Listen for late open-file requests (reserved for future single-instance forwarding). */
export async function listenForOpenFileRequests(): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const unlisten = await listen<string[]>('open-files', event => {
      void openAuthorizedPaths(event.payload ?? [])
    })
    return unlisten
  } catch {
    return () => {}
  }
}
