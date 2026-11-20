import { useState } from 'react'
import { useI18n } from '../lib/i18n'

/** Remains outside xterm's alternate screen so a TUI redraw cannot hide the incident. */
export default function TerminalExitNotice({ exitCode, restoreUnavailable = false, onReopen, onExport }: {
  exitCode: number | null
  restoreUnavailable?: boolean
  onReopen: () => Promise<unknown>
  onExport: () => Promise<unknown>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  return (
    // 占布局的底部条：只淡入；不做退出残影，否则残影多占 100ms 会推迟终端回填高度。
    <div role="status" className="view-fade flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-warn/30 bg-bg-deep px-3 py-2 text-ui-sm text-fg">
      <span className="min-w-0 flex-1 text-warn">
        {restoreUnavailable ? t('暂时无法接回终端，输出已保留。') : exitCode === null ? t('终端会话已结束，输出已保留。')
          : t('终端进程已结束（退出码 {code}），输出已保留。', { code: exitCode })}
      </span>
      <button type="button" disabled={busy} onClick={() => void run(onReopen)} className="btn btn-ghost btn-sm">
        {restoreUnavailable ? t('重试接回') : t('重新打开终端')}
      </button>
      <button type="button" disabled={busy} onClick={() => void run(onExport)} className="btn btn-ghost btn-sm">
        {t('导出终端诊断')}
      </button>
    </div>
  )
}
