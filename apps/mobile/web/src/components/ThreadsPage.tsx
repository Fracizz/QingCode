import { t, translateMessage } from '@qn/codex-client'
import { useEffect, useRef, useState } from 'react'
import { agentLabel, threadKey } from '../agents'
import { pageName } from '../names'
import { targetAgents, useApp } from '../store'
import { Button, Empty, Header, Loading, Note } from './ui'
import { ProjectTools } from './ProjectTools'
import { NewSessionButton } from './NewSessionButton'
import { WorkspaceIcon, WorkspaceSearch, WorkspaceThreadRow } from './WorkspaceHome'
import { SortableList } from './SortableList'
import { groupWorkspaceThreads, placeWorkspaceThread, useWorkspacePreferences } from '../workspace'

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
  const goBack = useApp((s) => s.goBack)
  const refreshThreads = useApp((s) => s.refreshThreads)
  const openThread = useApp((s) => s.openThread)
  const preferences = useWorkspacePreferences()
  const desktopId = useApp((s) => s.activeId)
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
  const shown = project ? groupWorkspaceThreads(threads.map((thread) => ({ ...thread, targetId: project.targetId, projectId: project.id })), [project], query, preferences)[0]?.threads ?? [] : []

  return (
    <>
      <Header
        className="qn-threads-header"
        title={project?.name || pageName('sessions')}
        subtitle={project && (targets.find((target) => target.id === project.targetId)?.name ?? pageName('sessions'))}
        onBack={goBack}
        right={
          <>
            {project && <ProjectTools key={`${desktopId}:${project.id}`} project={project} compact terminalShortcut className="qn-header-icon" />}
            <Button variant="ghost" className="qn-header-icon" onClick={() => void refreshThreads()} disabled={loading} aria-label={t('刷新会话')}>
              <WorkspaceIcon name="refresh" />
            </Button>
          </>
        }
      />
      <div className="qn-body qn-scroll">
        {threadsError ? (
          <Note message={threadsError} tone="error" actionLabel={t('重试')} onAction={() => void refreshThreads()} />
        ) : (
          agents
            .filter((agent) => agentErrors[agent])
            .map((agent) => (
              <Note
                key={agent}
                message={t('{name}：{message}', { name: agentLabel(agent), message: translateMessage(agentErrors[agent] ?? '') })}
                tone="warn"
                actionLabel={t('重试')}
                onAction={() => void refreshThreads()}
              />
            ))
        )}
        {threads.length > 0 && <WorkspaceSearch label={t('搜索会话')} query={query} onChange={setQuery} />}
        {(loading || !settled) && threads.length === 0 && !threadsError && <Loading text={t('正在读取会话…')} />}
        {settled && !loading && shown.length === 0 && !threadsError && (
          <Empty>{query ? t('没有匹配的会话。') : t('还没有会话。点「新建会话」开始。')}</Empty>
        )}
        {shown.length > 0 && (
          // 与首页分组共用一份会话顺序；搜索时不排序，避免只按筛选结果保存。
          <SortableList items={shown} itemKey={(thread) => threadKey(thread.agent, thread.id)}
            disabled={Boolean(query.trim()) || !desktopId || !project} className="qn-list-group qn-list-plain mt-3"
            label={t('{name} 的会话', { name: project?.name ?? '' })}
            onMove={(from, to) => { if (desktopId && project) placeWorkspaceThread(desktopId, project, shown, from, to) }}>
            {(thread) => <WorkspaceThreadRow thread={thread} onOpen={() => void openThread(thread.id, thread.agent)} />}
          </SortableList>
        )}
      </div>
      {project && <div className="qn-footer flex gap-2">
        <NewSessionButton project={project} className="flex-1" primary />
      </div>}
    </>
  )
}
