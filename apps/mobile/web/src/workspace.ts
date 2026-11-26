import { create } from 'zustand'
import { sessionKey } from './agents'
import { getGateway } from './client'
import { parseProjects, type ThreadSummary } from './state'
import { useApp } from './store'
import type { Project, Target } from './types'

export type WorkspaceTab = 'sessions' | 'projects' | 'connections'
export type WorkspaceThread = ThreadSummary & {
  targetId: string
  projectId: string
  unread?: boolean
}
type ProjectList = { items: Project[]; loading: boolean; error: boolean }
type WorkspaceGroup = { project: Project; threads: WorkspaceThread[] }

const STORE_KEY = 'workspace.sessions'
const MAX_SESSIONS = 100
const defaultProjects: ProjectList = { items: [], loading: false, error: false }
const stack: Array<() => void> = []

export function registerBackHandler(close: () => void): () => void {
  stack.push(close)
  return () => {
    const index = stack.lastIndexOf(close)
    if (index >= 0) stack.splice(index, 1)
  }
}

export function closeTopSheet(): boolean {
  const close = stack.at(-1)
  if (!close) return false
  close()
  return true
}

export function workspaceThreadKey(thread: Pick<WorkspaceThread, 'targetId' | 'projectId' | 'agent' | 'id'>): string {
  return JSON.stringify([thread.targetId, thread.projectId, thread.agent, thread.id])
}

export function filterProjects(projects: Project[], targets: Target[], query: string): Project[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return projects
  const byId = new Map(targets.map((target) => [target.id, target]))
  return projects.filter((project) => {
    const target = byId.get(project.targetId)
    return [project.name, project.path, target?.name, target?.kind === 'ssh' ? `远端 ${target.host}` : target?.name]
      .some((value) => value?.toLocaleLowerCase().includes(needle))
  })
}

export function groupWorkspaceThreads(threads: WorkspaceThread[], projects: Project[], query: string): WorkspaceGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  const groups = new Map<string, WorkspaceGroup>()
  const byId = new Map(projects.map((project) => [JSON.stringify([project.targetId, project.id]), project]))
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = JSON.stringify([thread.targetId, thread.projectId])
    const project = byId.get(key)
    if (!project) continue
    if (needle && ![thread.title, thread.preview, thread.agent, project.name, project.path].some((value) => value.toLocaleLowerCase().includes(needle))) continue
    const group = groups.get(key)
    if (group) group.threads.push(thread)
    else groups.set(key, { project, threads: [thread] })
  }
  return [...groups.values()]
}

type WorkspaceState = {
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  threads: Record<string, WorkspaceThread[]>
  projects: Record<string, ProjectList>
  loadProjects: (desktopId: string) => Promise<void>
}

const isThread = (row: unknown): row is WorkspaceThread => {
  if (!row || typeof row !== 'object') return false
  const value = row as Partial<WorkspaceThread>
  return typeof value.id === 'string' && typeof value.targetId === 'string' && typeof value.projectId === 'string'
    && typeof value.cwd === 'string' && typeof value.title === 'string' && typeof value.preview === 'string' && typeof value.updatedAt === 'number'
    && (value.agent === 'codex' || value.agent === 'claude' || value.agent === 'pi')
}

function mergeThreads(previous: WorkspaceThread[], next: WorkspaceThread[]): WorkspaceThread[] {
  const merged = new Map(previous.map((item) => [workspaceThreadKey(item), item]))
  for (const item of next) {
    const key = workspaceThreadKey(item)
    const old = merged.get(key)
    merged.set(key, { ...old, ...item, updatedAt: Math.max(old?.updatedAt ?? 0, item.updatedAt) })
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
}

let writeTimer: ReturnType<typeof setTimeout> | undefined
let storageWrites = Promise.resolve()
function persistThreads() {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    const stored = Object.fromEntries(Object.entries(useWorkspace.getState().threads).map(([id, rows]) => [
      id,
      rows.map(({ activity: _activity, ...thread }) => ({ ...thread, preview: '' })),
    ]))
    storageWrites = storageWrites.then(() => getGateway().storageSet(STORE_KEY, JSON.stringify(stored))).catch(() => undefined)
  }, 200)
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tab: 'sessions',
  setTab: (tab) => set({ tab }),
  threads: {},
  projects: {},
  loadProjects: async (desktopId) => {
    const connection = useApp.getState().connections.find((item) => item.id === desktopId)
    if (!connection || get().projects[desktopId]?.loading) return
    const patch = (value: Partial<ProjectList>) => set((state) => ({
      projects: {
        ...state.projects,
        [desktopId]: { ...(state.projects[desktopId] ?? defaultProjects), ...value },
      },
    }))
    patch({ loading: true, error: false })
    try {
      const data = await getGateway().rpc(connection, 'projects.list', {})
      if (!useApp.getState().connections.includes(connection)) {
        patch({ loading: false })
        return
      }
      const items = parseProjects(data)
      patch({ items, loading: false })
      if (get().tab !== 'sessions' || useApp.getState().activeId !== desktopId) return
      const discovered = await useApp.getState().discoverWorkspaceSessions(items)
      if (useApp.getState().activeId === desktopId && discovered.length) {
        set((state) => ({
          threads: { ...state.threads, [desktopId]: mergeThreads(state.threads[desktopId] ?? [], discovered) },
        }))
        persistThreads()
      }
    } catch {
      patch({ loading: false, error: true })
    }
  },
}))

export function startWorkspaceObserver(): () => void {
  let stop = false
  void getGateway().storageGet(STORE_KEY).then((raw) => {
    if (!raw || stop) return
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    useWorkspace.setState((state) => {
      const threads = { ...state.threads }
      for (const [id, rows] of Object.entries(data)) {
        if (Array.isArray(rows)) threads[id] = mergeThreads(rows.filter(isThread), threads[id] ?? [])
      }
      return { threads }
    })
  }).catch(() => undefined)

  const visibleChat = (state: ReturnType<typeof useApp.getState>, thread: WorkspaceThread) =>
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
    && state.page === 'chat' && state.selectedTargetId === thread.targetId
    && state.selectedThreadId === thread.id && state.selectedAgent === thread.agent
  const clearViewed = () => {
    const state = useApp.getState()
    const desktopId = state.activeId
    if (!desktopId) return
    const threads = useWorkspace.getState().threads[desktopId]
    if (!threads?.some((thread) => thread.unread && visibleChat(state, thread))) return
    useWorkspace.setState((current) => ({
      threads: { ...current.threads, [desktopId]: threads.map((thread) => (
        thread.unread && visibleChat(state, thread) ? { ...thread, unread: false } : thread
      )) },
    }))
    persistThreads()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', clearViewed)

  const unsubscribe = useApp.subscribe((now, before) => {
    if (now.connections !== before.connections) {
      const removed = before.connections.filter((item) => !now.connections.some((connection) => connection.id === item.id))
      if (removed.length) {
        useWorkspace.setState((state) => {
          const threads = { ...state.threads }
          const projects = { ...state.projects }
          for (const item of removed) {
            delete threads[item.id]
            delete projects[item.id]
          }
          return { threads, projects }
        })
        persistThreads()
      }
    }

    if (!now.activeId) return
    const { activeId: desktopId, selectedTargetId: targetId, selectedProjectId: projectId } = now
    const snapshots = targetId && projectId && now.threads !== before.threads
      ? now.threads.map((thread): WorkspaceThread => ({ ...thread, targetId, projectId, activity: thread.activity }))
      : []
    const desktopThreads = useWorkspace.getState().threads[desktopId] ?? []
    for (const cached of desktopThreads) {
      const key = sessionKey(cached.targetId, cached.agent)
      const current = now.sessions[key]?.state.threads[cached.id]
      const previous = before.activeId === desktopId ? before.sessions[key]?.state.threads[cached.id] : undefined
      const currentChat = visibleChat(now, cached)
      if (currentChat && cached.unread) {
        snapshots.push({ ...cached, unread: false })
      } else if (!currentChat && previous?.status === 'running' && current && current.status !== 'running') {
        snapshots.push({ ...cached, activity: undefined, unread: true, updatedAt: Date.now() })
      }
    }

    if (snapshots.length) {
      useWorkspace.setState((state) => ({
        threads: { ...state.threads, [desktopId]: mergeThreads(desktopThreads, snapshots) },
      }))
      persistThreads()
    }
  })
  return () => {
    stop = true
    unsubscribe()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', clearViewed)
  }
}

export async function showWorkspaceProject(targetId: string, projectId: string, keepPage = false): Promise<boolean> {
  const starting = useApp.getState()
  if (!starting.activeId) return false
  if (starting.selectedTargetId !== targetId || !starting.projects.some((item) => item.id === projectId)) {
    await starting.selectTarget(targetId)
  }
  const current = useApp.getState()
  if (current.activeId !== starting.activeId || current.selectedTargetId !== targetId
    || !current.projects.some((item) => item.id === projectId && item.targetId === targetId)) return false
  if (current.selectedProjectId !== projectId) await current.selectProject(projectId)
  else if (!keepPage) useApp.setState({ page: 'threads' })
  const result = useApp.getState()
  return result.activeId === starting.activeId && result.selectedTargetId === targetId && result.selectedProjectId === projectId
}

export async function openWorkspaceThread(thread: WorkspaceThread): Promise<void> {
  if (await showWorkspaceProject(thread.targetId, thread.projectId, true)) {
    await useApp.getState().openThread(thread.id, thread.agent)
  }
}

export function recentThreadStatus(thread: WorkspaceThread, view?: {
  status: string
  pendingApprovals: readonly unknown[]
}): 'pending' | 'running' | 'unread' | null {
  if (view?.pendingApprovals.length) return 'pending'
  if (view?.status === 'running') return 'running'
  if (!view && thread.activity) return thread.activity
  if (thread.unread) return 'unread'
  return null
}
