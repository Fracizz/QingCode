import { useEffect, useState } from 'react'
import { Activity, Square } from 'lucide-react'
import { AGENT_CAPABILITIES, backgroundTaskTypeLabel, t } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import { cn } from '../lib/cn'
import { useCodex } from '../store/codex'
import { LoadingIcon } from './LoadingIcon'
import { Badge, IconButton } from './ui'

/** 当前会话里轮次外仍在运行的后台任务，可逐个停止。 */
export function BackgroundTasksPanel({ targetId, agent, threadId, contentWidthClassName = 'max-w-3xl' }: {
  targetId: string
  agent: AgentKind
  threadId: string
  contentWidthClassName?: string
}) {
  const supported = AGENT_CAPABILITIES[agent].backgroundTasks
  const tasks = useCodex((s) => s.sessions[sessionKey(targetId, agent)]?.state.threads[threadId]?.backgroundTasks)
  const loaded = useCodex((s) => !!s.sessions[sessionKey(targetId, agent)]?.state.threads[threadId])
  const opened = useCodex((s) => !!s.sessions[sessionKey(targetId, agent)]?.opened)
  const refresh = useCodex((s) => s.refreshBackgroundTasks)
  const stop = useCodex((s) => s.stopBackgroundTask)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())

  // 重新打开会话或重连后补读一次，之后靠实时通知更新。
  useEffect(() => {
    if (supported && opened && loaded) void refresh({ targetId, agent, threadId })
  }, [supported, opened, loaded, refresh, targetId, agent, threadId])

  if (!supported || !tasks?.length) return null

  const stopTask = async (id: string) => {
    setStopping((current) => new Set(current).add(id))
    if (await stop({ targetId, agent, threadId }, id)) return
    setStopping((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  return (
    <div className="shrink-0 px-6 pb-1">
      <section
        aria-label={t('后台任务')}
        className={cn('mx-auto rounded-xl border border-qn-border bg-qn-panel px-3 py-2 text-ui-sm', contentWidthClassName)}
      >
        <div className="flex flex-wrap items-center gap-x-1.5 text-qn-muted">
          <Activity size={14} className="shrink-0" aria-hidden />
          <span>{t('后台任务（{count}）', { count: tasks.length })}</span>
          <span>{t('· 停止当前轮次不会结束它们')}</span>
        </div>
        <ul className="qn-scroll mt-1 max-h-32 space-y-0.5 overflow-auto">
          {tasks.map((task) => (
            <li key={task.id} className="flex min-h-7 items-center gap-1.5 rounded-md bg-qn-elevated px-2">
              <LoadingIcon size={11} />
              <Badge>{backgroundTaskTypeLabel(task.type)}</Badge>
              <span className="min-w-0 flex-1 truncate" title={task.description || task.id}>{task.description || task.id}</span>
              <IconButton
                label={t('停止任务 {name}', { name: task.description || task.id })}
                size="sm"
                disabled={!opened || stopping.has(task.id)}
                onClick={() => void stopTask(task.id)}
              >
                <Square size={11} fill="currentColor" strokeWidth={0} />
              </IconButton>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
