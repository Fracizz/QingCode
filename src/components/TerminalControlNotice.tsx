import { useState } from 'react'
import { Keyboard } from 'lucide-react'
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
      className="flex shrink-0 items-center gap-3 border-t border-border bg-bg-deep px-3 py-1 text-ui-sm"
    >
      <span className="min-w-0 flex-1 wrap-anywhere text-fg-muted">
        {t('正在 {name} 上使用，电脑只读', { name: control.name })}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void take()}
        className="inline-flex min-h-[var(--ui-control-height)] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-brand/10 px-2.5 font-medium text-brand hover:bg-brand/20 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
      >
        <Keyboard size={14} aria-hidden="true" />
        {isMobileTerminalId(terminalId) ? t('接管') : t('接回')}
      </button>
    </div>
  )
}
