import { useState } from 'react'
import { ChevronDown, ChevronRight, Download, Upload, X } from 'lucide-react'
import { useTransferStore, isTransferActive, type TransferStatus } from '../store/transferStore'
import { cancelSshTransfer, retrySshTransfer } from '../lib/sshTransfer'
import { useI18n } from '../lib/i18n'
import { formatBytes } from '../utils/formatBytes'
import Tooltip from './Tooltip'

const STATUS_LABELS: Record<TransferStatus, string> = {
  queued: '准备传输', running: '传输中', cancelling: '正在取消',
  completed: '传输完成', cancelled: '已取消', failed: '传输失败',
}

export default function TransferTasks() {
  const { t } = useI18n()
  const tasks = useTransferStore(state => state.tasks)
  const dismiss = useTransferStore(state => state.dismiss)
  const [collapsed, setCollapsed] = useState(false)
  if (tasks.length === 0) return null
  const activeCount = tasks.filter(task => isTransferActive(task.status)).length
  return (
    <section aria-label={t('文件传输')} className="ui-font-scaled shrink-0 border-t border-border bg-bg-sidebar text-ui-sm">
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-fg hover:bg-bg-hover">
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span>{t('文件传输')}</span>
        <span className="text-fg-muted" role="status">{t('{count} 项进行中', { count: activeCount })}</span>
      </button>
      {!collapsed && <div className="max-h-40 overflow-y-auto">
        {tasks.map(task => {
          const active = isTransferActive(task.status)
          const Icon = task.request.direction === 'upload' ? Upload : Download
          const canRetry = (task.status === 'failed' || task.status === 'cancelled')
            && (task.pendingPaths?.length ?? task.request.paths.length) > 0
          return (
            <div key={task.taskId} className="flex min-w-0 items-start gap-2 border-t border-border px-3 py-2">
              <Icon size={14} className="mt-0.5 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-fg">
                  <span role="status">{t(STATUS_LABELS[task.status])}</span>
                  <span className="text-fg-muted">{t('已完成 {count} 个文件 · {size}', { count: task.completedFiles, size: formatBytes(task.completedBytes) })}</span>
                </div>
                <p className="truncate text-fg-muted">{task.currentPath || task.request.destination}</p>
                {active && (task.currentTotalBytes ?? 0) > 0 && <progress
                  aria-label={t('当前文件进度')}
                  max={task.currentTotalBytes} value={task.currentBytes ?? 0}
                  className="mt-1 block h-1 w-full max-w-sm accent-accent"
                />}
                {task.error && <p className="mt-1 break-words text-danger">{task.error}</p>}
              </div>
              {active ? <button type="button" disabled={task.status === 'cancelling'} onClick={() => void cancelSshTransfer(task.taskId)}
                className="rounded border border-border-strong px-2 py-1 text-fg hover:bg-bg-hover disabled:opacity-50">{t('取消')}</button>
                : <>
                  {canRetry && <button type="button" onClick={() => void retrySshTransfer(task.taskId)}
                    className="rounded border border-border-strong px-2 py-1 text-fg hover:bg-bg-hover">{t('重试未完成项')}</button>}
                  <Tooltip label={t('关闭')}><button type="button" aria-label={t('关闭')} onClick={() => dismiss(task.taskId)} className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg"><X size={14} /></button></Tooltip>
                </>}
            </div>
          )
        })}
      </div>}
    </section>
  )
}
