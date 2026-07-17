import { listen } from '@tauri-apps/api/event'
import { safeInvoke, isTauri } from './tauri'
import { useEditorStore } from '../store/editorStore'

/** Open paths from Explorer "Open with" / CLI after the UI is ready. */
export async function openLaunchFiles(): Promise<void> {
  if (!isTauri()) return
  try {
    const paths = await safeInvoke<string[]>('打开启动文件', 'take_launch_files')
    for (const path of paths) {
      await useEditorStore.getState().openFile(path)
    }
  } catch (e) {
    console.error('openLaunchFiles failed:', e)
  }
}

/** Listen for late open-file requests (reserved for future single-instance forwarding). */
export async function listenForOpenFileRequests(): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const unlisten = await listen<string[]>('open-files', event => {
      for (const path of event.payload ?? []) {
        void useEditorStore.getState().openFile(path)
      }
    })
    return unlisten
  } catch {
    return () => {}
  }
}
