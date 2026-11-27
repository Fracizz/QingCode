// Agent 经 `qn notify` / `qn open` 发来的界面事件：daemon 广播 evt，这里转成系统通知与打开文件。
import type { UiNotifyEvt, UiOpenEvt } from '@qn/protocol'
import { onServerEvt } from '../workspace/serverCall'
import { openFile } from '../workspace/openers'

let installed = false

export function installAgentUiEvents(): void {
  if (installed) return
  installed = true
  onServerEvt<UiNotifyEvt>('ui.notify', (_targetId, evt) => {
    if (!evt || typeof evt.body !== 'string') return
    try {
      const notification = new Notification(evt.title || 'Agent 提醒', { body: evt.body })
      notification.onclick = () => window.focus()
    } catch {
      // 系统禁用通知时静默：提醒只是辅助，不影响会话。
    }
  })
  onServerEvt<UiOpenEvt>('ui.open', (targetId, evt) => {
    if (!evt || typeof evt.path !== 'string' || !evt.path) return
    openFile({
      targetId,
      path: evt.path,
      ...(evt.line ? { line: evt.line } : {}),
      ...(evt.column ? { column: evt.column } : {}),
    })
  })
}
