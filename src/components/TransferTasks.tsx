import { AlertCircle, CheckCircle2, Download, Upload, X } from 'lucide-react'
import { useTransferStore, isTransferActive, visibleTransferTasks, type TransferStatus } from '../store/transferStore'
import { cancelSshTransfer, retrySshTransfer } from '../lib/sshTransfer'
import { useI18n } from '../lib/i18n'
import { formatBytes } from '../utils/formatBytes'
import { formatTransferLocation, transferTaskDetail } from '../utils/transferLabel'
import Tooltip from './Tooltip'

const STATUS_LABELS: Record<TransferStatus, string> = {
  queued: '准备传输', running: '传输中', cancelling: '正在取消',
  completed: '传输完成', cancelled: '已取消', failed: '传输失败',
}

/**
 * 轻量传输卡片：与 Toast 同栈浮在右下角，不占布局；成功后自动消失，
 * 失败/取消保留到用户重试或关闭。
 */
export default function TransferTasks() {
  const { t } = useI18n()
  const tasks = visibleTransferTasks(useTransferStore(state => state.tasks))
  const dismiss = useTransferStore(state => state.dismiss)
  if (tasks.length === 0) return null
  return (
    <>
      {tasks.map(task => {
        const active = isTransferActive(task.status)
        const failed = task.status === 'failed'
        const Icon = task.status === 'completed' ? CheckCircle2
          : failed ? AlertCircle
            : task.request.direction === 'upload' ? Upload : Download
        const iconColor = task.status === 'completed' ? 'text-ok' : failed ? 'text-danger' : 'text-accent'
        const canRetry = (failed || task.status === 'cancelled')
          && (task.pendingPaths?.length ?? task.request.paths.length) > 0
        const detail = transferTaskDetail(task)
        const fullLocation = formatTransferLocation(task.currentPath || task.request.destination)
        const progress = active && (task.currentTotalBytes ?? 0) > 0
          ? Math.min(1, (task.currentBytes ?? 0) / task.currentTotalBytes!) : null
        return (
          <section key={task.taskId} aria-label={t('文件传输')}
            className="toast-enter relative overflow-hidden rounded-lg border border-border-strong bg-bg-elevated px-3 py-2 text-ui-sm shadow-elevation-2">
            <div className="flex min-w-0 items-center gap-2">
              <Icon size={14} className={`shrink-0 ${iconColor}`} />
              <Tooltip label={fullLocation} onlyWhenOverflow side="top" wrapperClassName="min-w-0 flex-1">
                <span className="block truncate text-fg">{detail}</span>
              </Tooltip>
              <span className="shrink-0 text-fg-muted" role="status">
                {active
                  ? formatBytes(task.completedBytes + (task.currentBytes ?? 0))
                  : t(STATUS_LABELS[task.status])}
              </span>
              {active ? (
                <Tooltip label={t('取消')}>
                  <button type="button" aria-label={t('取消')} disabled={task.status === 'cancelling'}
                    onClick={() => void cancelSshTransfer(task.taskId)}
                    className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"><X size={14} /></button>
                </Tooltip>
              ) : <>
                {canRetry && <button type="button" onClick={() => void retrySshTransfer(task.taskId)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-bg-hover">{t('重试')}</button>}
                <Tooltip label={t('关闭')}>
                  <button type="button" aria-label={t('关闭')} onClick={() => dismiss(task.taskId)}
                    className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"><X size={14} /></button>
                </Tooltip>
              </>}
            </div>
            {task.error && <p className="mt-1 break-words text-danger">{task.error}</p>}
            {active && (
              <span aria-hidden="true" className="absolute bottom-0 left-0 h-[2px] bg-accent transition-[width] duration-150"
                style={{ width: `${(progress ?? 0) * 100}%` }} />
            )}
          </section>
        )
      })}
    </>
  )
}
