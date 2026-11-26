import { useState } from 'react'
import { agentLabel, threadKey } from '../agents'
import { defaultAgentFor, targetAgents, unavailableAgents, useApp } from '../store'
import type { AgentKind } from '../types'
import { Button, Dialog, Empty, Header, Loading, Note } from './ui'
import { RateLimitBadge } from './RateLimitView'
import { ProjectTools } from './ProjectTools'
import { WorkspaceIcon, WorkspaceSearch, WorkspaceThreadRow } from './WorkspaceHome'
import { groupWorkspaceThreads } from '../workspace'

/** 新建会话时选 Agent：只列电脑设置里启用的；打开失败的置灰并给出原因，但仍可点（会重试打开）。 */
function AgentPickerDialog({
  agents,
  preferred,
  unavailable,
  reasons,
  onPick,
  onClose,
}: {
  agents: AgentKind[]
  preferred: AgentKind
  unavailable: Set<AgentKind>
  reasons: Partial<Record<AgentKind, string>>
  onPick: (agent: AgentKind) => void
  onClose: () => void
}) {
  return (
    <Dialog title="新建会话" onClose={onClose}>
      <div className="space-y-2">
        {agents.map((agent) => {
          const disabled = unavailable.has(agent)
          return (
            <button
              key={agent}
              type="button"
              className={`qn-row rounded-xl border px-3 py-2 ${disabled ? 'opacity-60' : ''} ${
                agent === preferred ? 'border-qn-accent bg-qn-accent/10' : 'border-qn-border'
              }`}
              onClick={() => onPick(agent)}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {agentLabel(agent)}
                  {agent === preferred && <span className="text-[11px] text-qn-muted">默认</span>}
                </span>
                {disabled && reasons[agent] && (
                  <span className="block text-[11px] leading-4 text-qn-danger">{reasons[agent]}</span>
                )}
                {agent === 'pi' && !disabled && (
                  <span className="block text-[11px] leading-4 text-qn-muted">pi 不经审批直接执行工具</span>
                )}
              </span>
              <span className="text-qn-muted">›</span>
            </button>
          )
        })}
      </div>
    </Dialog>
  )
}

export function ThreadsPage() {
  const projects = useApp((s) => s.projects)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedTargetId = useApp((s) => s.selectedTargetId)
  const threads = useApp((s) => s.threads)
  const loading = useApp((s) => s.threadsLoading)
  const threadsError = useApp((s) => s.threadsError)
  const agentErrors = useApp((s) => s.agentErrors)
  const agentSettings = useApp((s) => s.agentSettings)
  const sessions = useApp((s) => s.sessions)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const goBack = useApp((s) => s.goBack)
  const refreshThreads = useApp((s) => s.refreshThreads)
  const newThread = useApp((s) => s.newThread)
  const openThread = useApp((s) => s.openThread)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')

  const project = projects.find((item) => item.id === selectedProjectId)
  const agents = targetAgents({ agentSettings }, selectedTargetId)
  const unavailable = selectedTargetId ? unavailableAgents({ sessions }, selectedTargetId, agents) : new Set<AgentKind>()
  const preferred = selectedTargetId ? defaultAgentFor({ agentSettings, sessions }, selectedTargetId) : agents[0]
  const multiAgent = agents.length > 1
  const shown = project ? groupWorkspaceThreads(threads.map((thread) => ({ ...thread, targetId: project.targetId, projectId: project.id })), [project], query)[0]?.threads ?? [] : []

  const startNew = () => {
    if (multiAgent) setPicking(true)
    else void newThread(agents[0])
  }

  return (
    <>
      <Header
        title="会话"
        subtitle={project?.name ?? ''}
        onBack={goBack}
        right={
          <>
            <RateLimitBadge targetId={selectedTargetId} hideWhenEmpty />
            {project && <ProjectTools project={project} />}
            <Button variant="ghost" onClick={() => void refreshThreads()} disabled={loading} aria-label="刷新会话">
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
        {loading && threads.length === 0 && <Loading text="正在读取会话…" />}
        {!loading && shown.length === 0 && !threadsError && (
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
      <div className="qn-footer flex gap-2">
        <Button className="flex-1" variant="primary" onClick={startNew}>
          ＋ 新建会话
        </Button>
      </div>
      {picking && preferred && (
        <AgentPickerDialog
          agents={agents}
          preferred={preferred}
          unavailable={unavailable}
          reasons={agentErrors}
          onPick={(agent) => {
            setPicking(false)
            void newThread(agent)
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )
}
