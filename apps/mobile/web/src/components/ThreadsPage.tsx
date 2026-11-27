import { useEffect, useRef, useState } from 'react'
import { agentLabel, threadKey } from '../agents'
import { targetAgents, useApp } from '../store'
import { Button, Empty, Header, Loading, Note } from './ui'
import { ProjectTools } from './ProjectTools'
import { NewSessionButton } from './NewSessionButton'
import { WorkspaceIcon, WorkspaceSearch, WorkspaceThreadRow } from './WorkspaceHome'
import { groupWorkspaceThreads } from '../workspace'

export function ThreadsPage() {
  const projects = useApp((s) => s.projects)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedTargetId = useApp((s) => s.selectedTargetId)
  const threads = useApp((s) => s.threads)
  const loading = useApp((s) => s.threadsLoading)
  const threadsError = useApp((s) => s.threadsError)
  const agentErrors = useApp((s) => s.agentErrors)
  const agentSettings = useApp((s) => s.agentSettings)
  const targets = useApp((s) => s.targets)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const goBack = useApp((s) => s.goBack)
  const refreshThreads = useApp((s) => s.refreshThreads)
  const openThread = useApp((s) => s.openThread)
  const [query, setQuery] = useState('')
  // 从对话页返回时用最近会话占位，避免等待完整列表期间显示空状态。
  const [settled, setSettled] = useState(threads.length > 0)
  const sawLoading = useRef(false)
  useEffect(() => {
    if (!loading) void refreshThreads({ skipFailed: threads.length > 0 })
    // 只在进入页面时补拉一次
  }, [])
  useEffect(() => {
    if (loading) sawLoading.current = true
    else if (sawLoading.current || threads.length > 0 || threadsError) setSettled(true)
  }, [loading, threads.length, threadsError])

  const project = projects.find((item) => item.id === selectedProjectId)
  const agents = targetAgents({ agentSettings }, selectedTargetId)
  const shown = project ? groupWorkspaceThreads(threads.map((thread) => ({ ...thread, targetId: project.targetId, projectId: project.id })), [project], query)[0]?.threads ?? [] : []

  return (
    <>
      <Header
        className="qn-threads-header"
        title={project?.name || '会话'}
        subtitle={project && (targets.find((target) => target.id === project.targetId)?.name ?? '会话')}
        onBack={goBack}
        right={
          <>
            {project && <ProjectTools project={project} compact />}
            <Button variant="ghost" className="qn-header-icon" onClick={() => void refreshThreads()} disabled={loading} aria-label="刷新会话">
              <WorkspaceIcon name="refresh" />
            </Button>
          </>
        }
      />
      <div className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {threadsError ? (
          <Note message={threadsError} tone="error" actionLabel="重试" onAction={() => void refreshThreads()} />
        ) : (
          agents
            .filter((agent) => agentErrors[agent])
            .map((agent) => (
              <Note
                key={agent}
                message={`${agentLabel(agent)}：${agentErrors[agent] ?? ''}`}
                tone="warn"
                actionLabel="重试"
                onAction={() => void refreshThreads()}
              />
            ))
        )}
        {threads.length > 0 && <WorkspaceSearch label="搜索会话" query={query} onChange={setQuery} />}
        {(loading || !settled) && threads.length === 0 && !threadsError && <Loading text="正在读取会话…" />}
        {settled && !loading && shown.length === 0 && !threadsError && (
          <Empty>{query ? '没有匹配的会话。' : '还没有会话。点「新建会话」开始。'}</Empty>
        )}
        {shown.length > 0 && (
          <div className="qn-list-group mt-3">
            {shown.map((thread) => (
              <WorkspaceThreadRow key={threadKey(thread.agent, thread.id)} thread={thread}
                onOpen={() => void openThread(thread.id, thread.agent)} />
            ))}
          </div>
        )}
      </div>
      {project && <div className="qn-footer flex gap-2">
        <NewSessionButton project={project} className="flex-1" primary />
      </div>}
    </>
  )
}
