import { useServerOperationStore, dismissServerOperation, serverOperationForProject, setServerOperationBackground, type ServerOperation } from '../store/serverOperationStore'
import { setSshOpeningBackground, useSshOpeningStore } from '../store/sshOpeningStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import ServerOperationProgress from './ServerOperationProgress'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { sshConnectionIdFromUri, sshConnectionTarget } from '../lib/sshWorkspace'
import { useProjectStore } from '../store/projectStore'
import SshOpeningDialog, { SshOpeningProgress } from './SshOpeningDialog'
import Tooltip from './Tooltip'

function OperationCard({ task }: { task: ServerOperation }) {
  const { t } = useI18n()
  return (
    <ServerOperationProgress key={task.rootUri} {...task} status={task.kind === 'update' ? '更新中' : '安装中'}
      actions={task.error ? <>
        <button type="button" className="rounded px-2 py-1 text-fg-muted hover:bg-bg-hover" onClick={() => dismissServerOperation(task.rootUri)}>{t('关闭')}</button>
        <button type="button" className="rounded px-2 py-1 text-accent hover:bg-bg-hover" onClick={() => task.kind === 'update' ? useUIStore.setState({ serverUpdateRootUri: task.rootUri }) : useUIStore.getState().openRemoteConnections()}>{t(task.kind === 'update' ? '更新远端服务' : '远程连接')}</button>
      </> : !task.finishedAt && (
        <button type="button" className="shrink-0 rounded px-2 py-1 text-ui-sm text-accent hover:bg-bg-hover" onClick={() => setServerOperationBackground(task.rootUri, true)}>{t('后台运行')}</button>
      )} />
  )
}

interface RemoteTask {
  key: string
  path: string
  name: string
  status: string
  state: 'running' | 'done' | 'attention'
  background?: () => void
  detail: ReactNode
}

export default function ServerOperationTasks() {
  const { t } = useI18n()
  const tasks = useServerOperationStore(s => s.tasks)
  const attempts = useSshOpeningStore(s => s.attempts)
  const updateRoot = useUIStore(s => s.serverUpdateRootUri)
  const openings = Object.values(attempts).sort((a, b) => b.id - a.id)
  const [cutoff, setCutoff] = useState(0)
  const [reviewId, setReviewId] = useState<number | null>(null)
  // Avoid flashing progress for cached opens. Progress events do not reset the delay.
  const next = Math.min(...openings.filter(a => !a.error && !a.background)
    .map(a => a.startedAt + 300).filter(time => time > cutoff))
  useEffect(() => {
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setCutoff(Math.max(next, Date.now())), Math.max(0, next - Date.now()))
    return () => clearTimeout(timer)
  }, [next])
  const shownByOpening = new Set<ServerOperation>()
  const items: RemoteTask[] = []
  for (const attempt of openings) {
    const operation = serverOperationForProject(tasks, attempt.project)
    if (operation) shownByOpening.add(operation)
    if (!attempt.error && (attempt.background || attempt.startedAt + 300 > cutoff)) continue
    const status = attempt.error ? '需要处理' : operation?.kind === 'update' ? '更新中' : attempt.reusingServer ? '正在打开远程项目' : '安装中'
    const background = () => {
      if (operation && !operation.finishedAt) setServerOperationBackground(operation.rootUri, true)
      setSshOpeningBackground(attempt.key, true)
    }
    items.push({ key: 'opening-' + attempt.id, path: attempt.project.path, name: attempt.project.name, status,
      state: attempt.error ? 'attention' : 'running', background: attempt.error ? undefined : background,
      detail: attempt.error
        ? <div className="space-y-2 p-3">
            <p className="break-words font-medium text-fg">{attempt.project.name}</p>
            <p role="alert" className="max-h-24 select-text overflow-y-auto whitespace-pre-wrap break-words text-ui-sm text-danger">{attempt.error}</p>
            <button type="button" className="rounded px-2 py-1 text-ui-sm text-accent hover:bg-bg-hover" onClick={() => setReviewId(attempt.id)}>{t('点击查看详情')}</button>
          </div>
        : <SshOpeningProgress attempt={attempt} operation={operation} status={status} onBackground={background} />,
    })
  }
  for (const task of Object.values(tasks)) {
    if (task.background || task.rootUri === updateRoot || shownByOpening.has(task)) continue
    items.push({ key: task.rootUri, path: task.rootUri, name: task.name,
      status: task.error ? '需要处理' : task.finishedAt ? '已完成' : task.kind === 'update' ? '更新中' : '安装中',
      state: task.error ? 'attention' : task.finishedAt ? 'done' : 'running',
      background: task.finishedAt ? undefined : () => setServerOperationBackground(task.rootUri, true),
      detail: <OperationCard task={task} />,
    })
  }
  const failed = openings.find(a => a.error && (items.length === 1 || a.id === reviewId))
  if (failed) {
    // Keep an open recovery dialog mounted if another task becomes visible.
    if (reviewId !== failed.id) setReviewId(failed.id)
    return <SshOpeningDialog key={failed.id} attempt={failed} />
  }
  if (items.length < 2) return items[0]?.detail ?? null
  return <RemoteTaskCard items={items} />
}

function RemoteTaskCard({ items }: { items: RemoteTask[] }) {
  const { t } = useI18n()
  const connections = useProjectStore(s => s.sshConnections)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string>()
  const current = items.find(item => item.key === selected) ?? items[0]
  const running = items.filter(item => item.state === 'running')
  const errors = items.filter(item => item.state === 'attention')
  const completed = items.length - running.length - errors.length
  const Chevron = expanded ? ChevronUp : ChevronDown
  return <section aria-label={t('远程任务')} className="min-w-0">
    <div className="flex max-h-[calc(100dvh-5rem)] flex-col overflow-y-auto rounded-lg border border-dialog-border bg-dialog shadow-elevation-3 [&>:not(ul)]:shrink-0">
      <div className="flex flex-wrap items-center gap-x-2 bg-dialog-chrome px-3 py-1.5 text-ui-sm">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
          className="flex flex-wrap items-center gap-x-2 rounded py-1 text-fg hover:bg-bg-hover">
          <Chevron size={14} aria-hidden /> <strong>{t('远程任务')} {items.length}</strong>
          <span className="text-fg-muted">{t('进行中')} {running.length} · {t('已完成')} {completed}</span>
        </button>
        {errors.length > 0 && <button type="button" className="rounded px-1 py-1 text-danger hover:bg-bg-hover" onClick={() => {
          setSelected(errors[0].key)
          setExpanded(true)
        }}>{t('{count} 项需处理', { count: String(errors.length) })}</button>}
      </div>
      {expanded && <ul aria-label={t('远程任务')} className="min-h-12 max-h-[min(28dvh,15rem)] overflow-y-auto overscroll-contain border-y border-dialog-separator bg-dialog-sidebar">
        {items.map(item => {
          const id = sshConnectionIdFromUri(item.path)
          const connection = connections.find(c => c.id === id)
          const source = connection?.name.trim() || (connection ? sshConnectionTarget(connection) : id)
          return <li key={item.key}>
            <button type="button" aria-pressed={item === current} onClick={() => setSelected(item.key)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm ${item === current ? 'bg-dialog-active' : 'hover:bg-bg-hover'}`}>
              <Tooltip label={source || item.name} onlyWhenOverflow wrapperClassName="min-w-0 flex-1"><span className="block truncate font-medium text-fg">{source || item.name}</span></Tooltip>
              {source && <Tooltip label={item.name} onlyWhenOverflow wrapperClassName="min-w-0 flex-1"><span className="block truncate text-fg-muted">{item.name}</span></Tooltip>}
              <span className={`shrink-0 ${item.state === 'attention' ? 'text-danger' : item.state === 'done' ? 'text-ok' : 'text-accent'}`}>{t(item.status)}</span>
            </button>
          </li>
        })}
      </ul>}
      <div key={current.key} className="[&_.server-operation-card]:rounded-none [&_.server-operation-card]:border-0 [&_.server-operation-card]:shadow-none">{current.detail}</div>
      {running.length > 0 && <div className="border-t border-dialog-separator px-3 py-1 text-right">
        <button type="button" className="rounded px-2 py-1 text-ui-sm text-accent hover:bg-bg-hover" onClick={() => running.forEach(item => item.background?.())}>{t('全部转入后台')}</button>
      </div>}
    </div>
  </section>
}
