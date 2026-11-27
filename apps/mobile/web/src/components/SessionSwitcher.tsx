import { useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import type { Project } from '../types'
import { groupWorkspaceThreads, openWorkspaceThread, useWorkspace, visibleWorkspaceThreads, workspaceThreadKey, type WorkspaceThread } from '../workspace'
import { ProjectOrigin, WorkspaceSearch, WorkspaceThreadRow } from './WorkspaceHome'
import { NewSessionButton } from './NewSessionButton'
import { Button, Dialog, Note } from './ui'

const emptyThreads: WorkspaceThread[] = []

export function SessionSwitcher({ onClose }: { onClose: () => void }) {
  const activeId = useApp((s) => s.activeId)
  const archived = useApp((s) => s.archivedThreads)
  const targetId = useApp((s) => s.selectedTargetId)
  const projectId = useApp((s) => s.selectedProjectId)
  const threadId = useApp((s) => s.selectedThreadId)
  const agent = useApp((s) => s.selectedAgent)
  const currentThreads = useApp((s) => s.threads)
  const currentProjects = useApp((s) => s.projects)
  const targets = useApp((s) => s.targets)
  const recentThreads = useWorkspace((s) => activeId ? s.threads[activeId] : undefined) ?? emptyThreads
  const allProjects = useWorkspace((s) => activeId ? s.projects[activeId]?.items : undefined)
  const [scope, setScope] = useState<'project' | 'all'>('project')
  const [query, setQuery] = useState('')
  const [openError, setOpenError] = useState<string | null>(null)
  const pendingOpen = useRef<Promise<boolean> | null>(null)
  const currentProject = currentProjects.find((project) => project.id === projectId && project.targetId === targetId)
  const groups = useMemo(() => {
    const cached = new Map(recentThreads.map((thread) => [workspaceThreadKey(thread), thread]))
    if (targetId && projectId) {
      for (const thread of currentThreads) {
        const item = { ...thread, targetId, projectId }
        const key = workspaceThreadKey(item)
        cached.set(key, { ...cached.get(key), ...item })
      }
    }
    const candidates = scope === 'all' ? [...cached.values()] : [...cached.values()]
      .filter((thread) => thread.targetId === targetId && thread.projectId === projectId)
    const byId = new Map([...(allProjects ?? []), ...currentProjects].map((project) => [project.id, project]))
    return groupWorkspaceThreads(visibleWorkspaceThreads(candidates, activeId, archived), [...byId.values()], query)
  }, [scope, recentThreads, currentThreads, targetId, projectId, allProjects, currentProjects, activeId, archived, query])

  function close() {
    const state = useApp.getState()
    if (pendingOpen.current && state.openingThread) state.cancelPendingNavigation()
    pendingOpen.current = null
    onClose()
  }

  async function selectThread(thread: WorkspaceThread, project: Project) {
    setOpenError(null)
    const task = openWorkspaceThread(thread, project)
    pendingOpen.current = task
    const opened = await task
    if (pendingOpen.current !== task) return
    pendingOpen.current = null
    if (opened) onClose()
    else setOpenError(useApp.getState().error)
  }

  return (
    <Dialog title="切换会话" onClose={close} placement="side">
      <div className="qn-segment mb-3" aria-label="会话范围">
        <Button aria-pressed={scope === 'project'} onClick={() => setScope('project')}>本项目</Button>
        <Button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>全部</Button>
      </div>
      {scope === 'project' && currentProject && <NewSessionButton project={currentProject} className="w-full" onCreated={onClose} />}
      <WorkspaceSearch label="搜索会话" query={query} onChange={setQuery} />
      {openError && <Note tone="error" message={openError} onClose={() => setOpenError(null)} />}
      <div className="qn-switcher-list">
        {groups.length ? groups.map(({ project, threads }) => (
          <section key={project.id} className="qn-workspace-group">
            <div className="qn-group-heading">
              <h3 className="truncate">{project.name}</h3>
              <ProjectOrigin target={targets.find((target) => target.id === project.targetId)} />
              {scope === 'all' && targets.some((target) => target.id === project.targetId) && (
                <NewSessionButton project={project} iconOnly className="qn-header-icon" onCreated={onClose} />
              )}
            </div>
            <div className="qn-list-group">
              {threads.map((thread) => {
                const selected = thread.id === threadId && thread.agent === agent
                  && thread.targetId === targetId && thread.projectId === projectId
                return (
                  <WorkspaceThreadRow key={workspaceThreadKey(thread)} thread={thread} selected={selected}
                    onOpen={() => { if (selected) close(); else void selectThread(thread, project) }} />
                )
              })}
            </div>
          </section>
        )) : <p className="my-6 text-center text-sm text-qn-muted">{query ? '没有匹配的会话。' : '还没有会话。'}</p>}
      </div>
      <Button className="mt-4 w-full shrink-0" onClick={() => {
        close()
        useWorkspace.getState().setTab('sessions')
        useApp.setState({ page: 'workspace' })
      }}>返回工作台</Button>
    </Dialog>
  )
}
