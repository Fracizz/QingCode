import { t } from '@qn/codex-client'
import { useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import type { Project } from '../types'
import { groupWorkspaceThreads, openWorkspaceThread, useWorkspace, useWorkspacePreferences, visibleWorkspaceThreads, workspaceThreadKey, type WorkspaceThread } from '../workspace'
import { ProjectOrigin, WorkspaceSearch, WorkspaceThreadRow } from './WorkspaceHome'
import { NewSessionButton } from './NewSessionButton'
import { Button, Dialog } from './ui'

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
  const preferences = useWorkspacePreferences()
  const [scope, setScope] = useState<'project' | 'all'>('project')
  const [query, setQuery] = useState('')
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
    return groupWorkspaceThreads(visibleWorkspaceThreads(candidates, activeId, archived), [...byId.values()], query, preferences)
  }, [scope, recentThreads, currentThreads, targetId, projectId, allProjects, currentProjects, activeId, archived, query, preferences])

  function close() {
    const state = useApp.getState()
    if (pendingOpen.current && state.openingThread) state.cancelPendingNavigation()
    pendingOpen.current = null
    onClose()
  }

  async function selectThread(thread: WorkspaceThread, project: Project) {
    const task = openWorkspaceThread(thread, project)
    pendingOpen.current = task
    const opened = await task
    if (pendingOpen.current !== task) return
    pendingOpen.current = null
    // 打开失败的原因由全局悬浮提示展示。
    if (opened) onClose()
  }

  return (
    <Dialog title={t('切换会话')} onClose={close} placement="left">
      <div className="qn-segment mb-3" aria-label={t('会话范围')}>
        <Button aria-pressed={scope === 'project'} onClick={() => setScope('project')}>{t('本项目')}</Button>
        <Button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{t('全部')}</Button>
      </div>
      {scope === 'project' && currentProject && <NewSessionButton project={currentProject} className="w-full" onCreated={onClose} />}
      <WorkspaceSearch label={t('搜索会话')} query={query} onChange={setQuery} />
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
        )) : <p className="my-6 text-center text-sm text-qn-muted">{query ? t('没有匹配的会话。') : t('还没有会话。')}</p>}
      </div>
      <Button className="mt-4 w-full shrink-0" onClick={() => {
        close()
        useWorkspace.getState().setTab('sessions')
        useApp.setState({ page: 'workspace' })
      }}>{t('返回工作台')}</Button>
    </Dialog>
  )
}
