import { AGENT_CAPABILITIES, backgroundTaskTypeLabel, t } from '@qn/codex-client'
import { Activity, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { sessionKey } from '../agents'
import { useApp } from '../store'
import { Badge, Button, LoadingIcon } from './ui'

/** 当前会话里轮次外仍在运行的后台任务。停止当前轮次不会结束它们，只能在这里逐个停止。 */
export function BackgroundTasks() {
  const targetId = useApp((s) => s.selectedTargetId)
  const threadId = useApp((s) => s.selectedThreadId)
  const agent = useApp((s) => s.selectedAgent)
  const supported = AGENT_CAPABILITIES[agent].backgroundTasks
  const key = targetId ? sessionKey(targetId, agent) : ''
  const tasks = useApp((s) => threadId ? s.sessions[key]?.state.threads[threadId]?.backgroundTasks : undefined)
  const ready = useApp((s) => {
    const session = s.sessions[key]
    return s.eventsConnected && !!threadId && !!session?.opened && !session.linkInterrupted && !!session.state.threads[threadId]
  })
  const refresh = useApp((s) => s.refreshBackgroundTasks)
  const stop = useApp((s) => s.stopBackgroundTask)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())

  // 打开会话或重连后补读一次，之后靠实时通知更新。
  useEffect(() => {
    if (supported && ready) void refresh()
  }, [supported, ready, refresh, key, threadId])

  if (!supported || !tasks?.length) return null

  const stopTask = async (id: string) => {
    setStopping((current) => new Set(current).add(id))
    if (await stop(id)) return
    setStopping((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  return (
    <section className="qn-queue" aria-label={t('后台任务')}>
      <details className="qn-details qn-queue-details" open>
        <summary>
          <Activity size={15} className="mr-1.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('后台任务（{count}）', { count: tasks.length })}</span>
        </summary>
        <p className="mb-1 pr-2 text-xs text-qn-muted">{t('停止当前轮次不会结束后台任务。')}</p>
        <ul className="qn-scroll qn-queue-list">
          {tasks.map((task) => (
            <li key={task.id} className="qn-queue-item">
              <LoadingIcon size={13} />
              <Badge>{backgroundTaskTypeLabel(task.type)}</Badge>
              <span className="min-w-0 flex-1 truncate">{task.description || task.id}</span>
              <Button variant="ghost" className="qn-icon-button shrink-0"
                aria-label={t('停止任务 {name}', { name: task.description || task.id })}
                disabled={!ready || stopping.has(task.id)} onClick={() => void stopTask(task.id)}>
                <Square size={13} fill="currentColor" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
