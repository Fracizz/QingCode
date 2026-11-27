import { useEffect, useState } from 'react'
import { ArchiveRestore, RotateCw } from 'lucide-react'
import { agentLabel } from '../../lib/agents'
import { friendlyError } from '../../lib/errors'
import { formatTime, threadKey, type ThreadSummary } from '../../lib/threads'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { EmptyState, ErrorNote, Modal, Spinner } from '../ui'

export function ArchivedThreadsDialog({ targetId, onClose }: { targetId: string; onClose: () => void }) {
  const ready = useTargets((state) => state.states[targetId]?.state === 'ready')
  const name = useTargets((state) => state.targets.find((target) => target.id === targetId)?.name) ?? targetId
  const listArchivedThreads = useCodex((state) => state.listArchivedThreads)
  const restoreThread = useCodex((state) => state.restoreThread)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void listArchivedThreads(targetId).then(({ threads, error }) => {
      if (cancelled) return
      setThreads(threads)
      setLoadError(error)
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(friendlyError(error, '加载已归档会话失败'))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [listArchivedThreads, ready, revision, targetId])

  const reload = () => setRevision((value) => value + 1)
  const restore = async (thread: ThreadSummary) => {
    const key = threadKey(thread.agent, thread.id)
    setRestoring(key)
    setRestoreError(null)
    try {
      await restoreThread(targetId, thread)
      setThreads((list) => list.filter(({ agent, id }) => threadKey(agent, id) !== key))
    } catch (error) {
      setRestoreError(friendlyError(error, '恢复会话失败'))
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Modal
      title="已归档会话"
      description={`${name} · 恢复后会话将重新出现在项目列表中。`}
      onClose={onClose}
      width="max-w-2xl"
      footer={(
        <div className="flex justify-end">
          <button type="button" className="qn-button-subtle gap-1.5" disabled={!ready || loading || restoring !== null} onClick={reload}>
            <RotateCw size={14} aria-hidden="true" /> 刷新
          </button>
        </div>
      )}
    >
      {!ready ? <EmptyState>连接此目标后即可查看已归档会话。</EmptyState> : (
        <>
          <ErrorNote message={loadError} onRetry={restoring === null ? reload : undefined} />
          <ErrorNote message={restoreError} onClose={() => setRestoreError(null)} />
          {loading ? <div className="py-5"><Spinner label="正在加载已归档会话…" /></div> : (
            threads.length === 0 && !loadError ? <EmptyState>暂无已归档会话。</EmptyState> : (
              <ul className="divide-y divide-qn-border">
                {threads.map((thread) => {
                  const key = threadKey(thread.agent, thread.id)
                  return (
                    <li key={key} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[length:var(--qn-session-font-size)] leading-tight font-medium text-qn-text" title={thread.title}>{thread.title}</p>
                        <p className="truncate text-[length:var(--qn-session-detail-font-size)] leading-tight text-qn-muted" title={thread.cwd}>
                          {agentLabel(thread.agent)} · {formatTime(thread.updatedAt)}{thread.cwd && ` · ${thread.cwd}`}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="qn-button-subtle shrink-0 gap-1.5"
                        aria-label={`恢复会话 ${thread.title}`}
                        disabled={restoring !== null}
                        onClick={() => void restore(thread)}
                      >
                        <ArchiveRestore size={14} aria-hidden="true" /> {restoring === key ? '恢复中…' : '恢复'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )
          )}
        </>
      )}
    </Modal>
  )
}
