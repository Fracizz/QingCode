import { getCurrentWindow } from '@tauri-apps/api/window'
import { translate } from './i18n'
import { listBusyTerminals } from '@/lib/terminal/terminalClose'
import { confirmDialog } from '../store/confirmStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'

/** Confirm dirty tabs / busy terminals, then destroy the current window. */
export async function requestAppClose() {
  // Only warn for busy terminals (child processes / run tasks). Idle shells
  // still get killed on quit, but should not look like "仍在运行".
  const busyTerminals = await listBusyTerminals(useTerminalStore.getState().terminals)
  const detail =
    busyTerminals.length > 0
      ? translate('{count} 个终端仍在运行，退出后将终止。', {
          count: busyTerminals.length,
        })
      : undefined

  if (
    !(await confirmDialog({
      title: translate('退出 QingCode'),
      message: translate('确定要关闭应用程序吗？'),
      detail,
      kind: 'warning',
      confirmLabel: translate('退出'),
      cancelLabel: translate('取消'),
    }))
  ) {
    return
  }
  if (!(await confirmDiscardTabs(useEditorStore.getState().getAllTabs(), '退出应用'))) return
  await getCurrentWindow().destroy()
}
