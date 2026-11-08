import { useState } from 'react'
import { useI18n } from '../lib/i18n'
import { isMobileTerminalId, takeTerminalForDesktop } from '@/lib/ipc/mobileSessions'
import { useProjectStore } from '@/store/projectStore'
import { useTerminalControlStore } from '@/store/terminalControlStore'

/** 其他设备使用终端期间显示在标签底部；画面继续实时显示，电脑不能输入。 */
export default function TerminalControlNotice({ terminalId }: { terminalId: string }) {
  const { t } = useI18n()
  const control = useTerminalControlStore(s => s.controls[terminalId])
  const [busy, setBusy] = useState(false)
  if (!control) return null
  const take = async () => {
    if (busy) return
    setBusy(true)
    try {
      await takeTerminalForDesktop(terminalId)
    } catch (error) {
      useProjectStore.getState().pushToast('error', String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      data-testid="terminal-control-notice"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-bg-deep px-3 py-2 text-ui-sm text-fg"
    >
      <span className="min-w-0 flex-1 text-fg-muted">
        {t('正在 {name} 上使用，电脑只读', { name: control.name })}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void take()}
        className="rounded px-2 py-1 hover:bg-bg-hover disabled:opacity-50"
      >
        {isMobileTerminalId(terminalId) ? t('接管') : t('接回')}
      </button>
    </div>
  )
}
