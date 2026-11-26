import { formatTime } from '../state'
import { useApp } from '../store'
import { Button, Card, Empty, Header, Loading, Note } from './ui'
import { RateLimitBadge } from './RateLimitView'

export function ThreadsPage() {
  const projects = useApp((s) => s.projects)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedTargetId = useApp((s) => s.selectedTargetId)
  const threads = useApp((s) => s.threads)
  const loading = useApp((s) => s.threadsLoading)
  const threadsError = useApp((s) => s.threadsError)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const goBack = useApp((s) => s.goBack)
  const refreshThreads = useApp((s) => s.refreshThreads)
  const newThread = useApp((s) => s.newThread)
  const openThread = useApp((s) => s.openThread)
  const ensureOpen = useApp((s) => s.ensureOpen)

  const project = projects.find((item) => item.id === selectedProjectId)

  return (
    <>
      <Header
        title="会话"
        subtitle={project?.name ?? ''}
        onBack={goBack}
        right={<RateLimitBadge targetId={selectedTargetId} />}
      />
      <div className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {threadsError && (
          <Note
            message={threadsError}
            tone="error"
            actionLabel="重试"
            onAction={() => {
              if (selectedTargetId) void ensureOpen(selectedTargetId).then(() => void refreshThreads())
            }}
          />
        )}
        {loading && <Loading text="正在读取会话…" />}
        {!loading && threads.length === 0 && !threadsError && (
          <Empty>还没有会话。点「新建会话」，或直接在对话页输入消息。</Empty>
        )}
        <div className="space-y-3">
          {threads.map((thread) => (
            <Card key={thread.id}>
              <button type="button" className="qn-row" onClick={() => void openThread(thread.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{thread.title}</span>
                  <span className="qn-subtitle block">{thread.preview || '（无预览）'}</span>
                  <span className="qn-subtitle block">{formatTime(thread.updatedAt)}</span>
                </span>
                <span className="text-qn-muted">›</span>
              </button>
            </Card>
          ))}
        </div>
      </div>
      <div className="qn-footer flex gap-2">
        <Button className="flex-1" onClick={() => void refreshThreads()}>
          刷新
        </Button>
        <Button className="flex-1" variant="primary" onClick={() => void newThread()}>
          ＋ 新建会话
        </Button>
      </div>
    </>
  )
}
