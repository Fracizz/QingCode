import { useEffect, useMemo, useState } from 'react'
import { sessionKey } from '../agents'
import { useApp } from '../store'
import type { Project, Target } from '../types'
import {
  filterProjects,
  groupWorkspaceThreads,
  openWorkspaceThread,
  recentThreadStatus,
  threadPreviewLine,
  showWorkspaceProject,
  useWorkspace,
  workspaceThreadKey,
  type WorkspaceTab,
  type WorkspaceThread,
} from '../workspace'
import { formatTime } from '../state'
import { AgentTag, Badge, Button, Empty, Loading, Note, StatusDot } from './ui'
import { ProjectTools } from './ProjectTools'

const tabs: { id: WorkspaceTab; title: string }[] = [
  { id: 'sessions', title: '会话' },
  { id: 'projects', title: '项目' },
  { id: 'connections', title: '连接' },
]
const emptyProjects: Project[] = []
const emptyThreads: WorkspaceThread[] = []

export function WorkspaceIcon({ name }: { name: WorkspaceTab | 'search' | 'refresh' | 'more' }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {name === 'sessions' && <path d="M20 11a7 7 0 0 1-7 7H5l1.5-2.5A7 7 0 0 1 11 4h2a7 7 0 0 1 7 7Z M9 11h6" />}
      {name === 'projects' && <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />}
      {name === 'connections' && <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
      {name === 'search' && <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></>}
      {name === 'refresh' && <path d="M20 11a8 8 0 0 0-14-5L4 8m0-5v5h5m-5 5a8 8 0 0 0 14 5l2-2m0 5v-5h-5" />}
      {name === 'more' && <><circle cx="5" cy="12" r=".9" /><circle cx="12" cy="12" r=".9" /><circle cx="19" cy="12" r=".9" /></>}
    </svg>
  )
}

export function WorkspaceNav() {
  const workspaceTab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const page = useApp((s) => s.page)
  const tab = page === 'connections' ? 'connections' : workspaceTab
  function navigate(id: WorkspaceTab) {
    setTab(id)
    if (page === 'connections') useApp.setState({ page: 'workspace' })
  }
  return (
    <nav className="qn-nav" aria-label="工作台">
      {tabs.map(({ id, title }) => (
        <button type="button" key={id} className="qn-nav-button" aria-current={id === tab ? 'page' : undefined}
          onClick={() => navigate(id)}>
          <span><WorkspaceIcon name={id} /></span>
          {title}
        </button>
      ))}
    </nav>
  )
}

export function WorkspaceSearch({
  label, query, onChange,
}: {
  label: string
  query: string
  onChange: (value: string) => void
}) {
  return (
    <div className="qn-search">
      <WorkspaceIcon name="search" />
      <input type="search" value={query} aria-label={label} placeholder={label} onChange={(event) => onChange(event.target.value)} />
      {query && <button type="button" aria-label="清空搜索" onClick={() => onChange('')}>×</button>}
    </div>
  )
}

export function ProjectOrigin({ target }: { target?: Target }) {
  const name = target?.kind === 'ssh' ? `远端 · ${target.name}` : target?.name ?? '目标已移除'
  return <span className="qn-origin" title={target?.kind === 'ssh' ? target.host : undefined}>{name}</span>
}

export function WorkspaceThreadRow({
  thread, onOpen, selected = false,
}: {
  thread: WorkspaceThread
  onOpen: () => void
  selected?: boolean
}) {
  const view = useApp((s) => s.sessions[sessionKey(thread.targetId, thread.agent)]?.state.threads[thread.id])
  const status = recentThreadStatus(thread, view)
  const preview = threadPreviewLine(thread.title, thread.preview)
  return (
    <button type="button" className="qn-row qn-list-row" aria-current={selected ? 'true' : undefined} onClick={onOpen}>
      <span className="qn-row-copy">
        <span className="qn-list-primary">
          <span className="truncate">{thread.title}</span>
          <AgentTag agent={thread.agent} />
        </span>
        {preview && <span className="qn-subtitle block">{preview}</span>}
        <span className="qn-subtitle block">{formatTime(thread.updatedAt)}</span>
      </span>
      {status === 'pending' && <Badge tone="warn">待审批</Badge>}
      {status === 'running' && <Badge tone="accent">运行中</Badge>}
      {status === 'unread' && <Badge tone="accent">有新结果</Badge>}
      <span className="text-qn-muted" aria-hidden>›</span>
    </button>
  )
}

export function WorkspaceProjectRow({ project, target, onOpen }: {
  project: Project
  target?: Target
  onOpen: () => void
}) {
  return (
    <div className="qn-row qn-list-row">
      <button type="button" className="qn-row-trigger" onClick={onOpen} disabled={!target}>
        <span className="qn-row-copy">
          <span className="qn-list-primary">{project.name}</span>
          <span className="qn-subtitle qn-mono block">{project.path}</span>
        </span>
        <span className="text-qn-muted" aria-hidden>›</span>
      </button>
      <ProjectTools project={project} />
    </div>
  )
}

export function WorkspaceHome() {
  const tab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const desktopId = useApp((s) => s.activeId)
  const connection = useApp((s) => s.connections.find((item) => item.id === s.activeId))
  const connected = useApp((s) => s.eventsConnected)
  const repairReason = useApp((s) => s.activeId ? s.needsRepair[s.activeId] : undefined)
  const beginRepair = useApp((s) => s.beginRepair)
  const notice = useApp((s) => s.notice)
  const error = useApp((s) => s.error)
  const clearError = useApp((s) => s.clearError)
  const targets = useApp((s) => s.targets)
  const loadTargets = useApp((s) => s.loadTargets)
  const loadProjects = useWorkspace((s) => s.loadProjects)
  const projectList = useWorkspace((s) => desktopId ? s.projects[desktopId] : undefined)
  const threadList = useWorkspace((s) => desktopId ? s.threads[desktopId] : undefined) ?? emptyThreads
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState(false)
  const projects = projectList?.items ?? emptyProjects
  const matchedProjects = useMemo(() => filterProjects(projects, targets, query), [projects, targets, query])
  const groups = useMemo(() => groupWorkspaceThreads(threadList, projects, query), [threadList, projects, query])

  useEffect(() => {
    if (desktopId) void loadProjects(desktopId)
  }, [desktopId, connected, tab, loadProjects])

  const open = async (action: () => Promise<unknown>) => {
    if (opening) return
    setOpening(true)
    try {
      await action()
    } finally {
      setOpening(false)
    }
  }
  const isSessions = tab === 'sessions'
  const showTargets = () => useApp.setState({ page: 'targets' })
  const refresh = () => {
    if (!desktopId) return
    void Promise.all([loadTargets(), loadProjects(desktopId)])
  }

  return (
    <main className="qn-body qn-scroll qn-workspace" aria-busy={opening}>
      <header className="qn-workspace-title" data-connected={connected}>
        <div className="qn-workspace-context">
          <button type="button" className="qn-inline-action" onClick={() => setTab('connections')}>
            <StatusDot tone={connected ? 'ok' : repairReason ? 'danger' : 'muted'} />
            <span className="truncate">{connection?.name ?? '未连接电脑'} · {connected ? '在线' : repairReason ? '待配对' : '离线'}</span>
            <span aria-hidden>›</span>
          </button>
          <Button variant="ghost" onClick={refresh} disabled={projectList?.loading} aria-label="刷新项目">
            <WorkspaceIcon name="refresh" />
          </Button>
        </div>
        <h1>{isSessions ? '会话' : '项目'}</h1>
      </header>
      {repairReason && desktopId && (
        <Note message={repairReason === 'fingerprint' ? '电脑证书已变化，请核对后重新配对。' : '电脑已撤销此设备的授权。'}
          tone="error" actionLabel="重新配对" onAction={() => beginRepair(desktopId)} />
      )}
      {notice && <Note message={notice} tone="warn" />}
      {error && <Note message={error} tone="error" onClose={clearError} />}
      {projectList?.error && !repairReason && (
        <Note message="读取项目失败，请检查电脑和网络。" tone="error" actionLabel="重试" onAction={refresh} />
      )}
      {projectList?.loading && projects.length === 0 ? <Loading text="正在读取项目…" /> : (
        <>
          <WorkspaceSearch label={isSessions ? '搜索会话或项目' : '搜索项目、主机或路径'} query={query} onChange={setQuery} />
          {isSessions ? (
            groups.length ? groups.map(({ project, threads }) => (
              <section key={project.id} className="qn-workspace-group">
                <div className="qn-group-heading">
                  <h2 className="truncate">{project.name}</h2>
                  <ProjectOrigin target={targets.find((item) => item.id === project.targetId)} />
                  <ProjectTools project={project} />
                  <Button variant="ghost" className="qn-group-action" onClick={() => void open(() => showWorkspaceProject(project.targetId, project.id))}
                    aria-label={`进入 ${project.name} 项目的会话`}>›</Button>
                </div>
                <div className="qn-list-group">
                  {threads.map((thread) => <WorkspaceThreadRow key={workspaceThreadKey(thread)} thread={thread}
                    onOpen={() => void open(() => openWorkspaceThread(thread))} />)}
                </div>
              </section>
            )) : (
              <Empty>
                <p>{query ? '没有匹配的会话。' : '还没有最近访问的会话。'}</p>
                <Button variant="primary" className="mt-3" onClick={() => { setQuery(''); setTab('projects') }}>选择项目</Button>
              </Empty>
            )
          ) : (
            matchedProjects.length ? targets.map((target) => {
              const rows = matchedProjects.filter((item) => item.targetId === target.id)
              if (!rows.length) return null
              return (
                <section key={target.id} className="qn-workspace-group">
                  <div className="qn-group-heading">
                    <h2><ProjectOrigin target={target} /></h2>
                  </div>
                  <div className="qn-list-group">
                    {rows.map((project) => <WorkspaceProjectRow key={project.id} project={project} target={target}
                      onOpen={() => void open(() => showWorkspaceProject(project.targetId, project.id))} />)}
                  </div>
                </section>
              )
            }) : <Empty>{query ? '没有匹配的项目。' : '在目标中选择或添加项目。'}</Empty>
          )}
          {(!isSessions || groups.length > 0) && (
            <Button className="mt-4 w-full" onClick={isSessions ? () => { setQuery(''); setTab('projects') } : showTargets}>
              {isSessions ? '从其他项目打开会话' : '管理目标与项目'}
            </Button>
          )}
        </>
      )}
    </main>
  )
}
