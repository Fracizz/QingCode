import { isActiveThread, isThreadOutcome, sessionStatus, t, type SessionStatus } from '@qn/codex-client'
import { create } from 'zustand'
import { archivedThreadKey, sessionKey } from './agents'
import { getGateway } from './client'
import { reorder } from './sortable'
import { parseProjects, parseStoredRecord, type ThreadSummary } from './state'
import { useApp } from './store'
import type { AgentKind, Project, Target } from './types'

export type WorkspaceTab = 'sessions' | 'projects' | 'connections'
type WorkspaceTabTap = { tab: WorkspaceTab; at: number }

export function isWorkspaceTabDoubleTap(previous: WorkspaceTabTap | null, current: WorkspaceTabTap): boolean {
  if (!previous || previous.tab !== current.tab) return false
  const elapsed = current.at - previous.at
  return elapsed >= 0 && elapsed <= 350
}

export type WorkspaceThread = ThreadSummary & {
  targetId: string
  projectId: string
  unread?: boolean
}
type ProjectList = { items: Project[]; loading: boolean; error: boolean; loaded: boolean }
type WorkspaceGroup = { project: Project; threads: WorkspaceThread[] }
type ThreadPreference = { title?: string; pinned?: boolean }
type WorkspacePreferences = {
  fp: string
  threads: Record<string, ThreadPreference>
  projectOrders: Record<string, string[]>
}

export const threadPreferenceKey = (targetId: string, agent: AgentKind, threadId: string) => JSON.stringify([targetId, agent, threadId])
const preferenceKey = (thread: Pick<WorkspaceThread, 'targetId' | 'agent' | 'id'>) => threadPreferenceKey(thread.targetId, thread.agent, thread.id)

export function useWorkspacePreferences() {
  const activeId = useApp((state) => state.activeId)
  const fp = useApp((state) => state.connections.find((item) => item.id === activeId)?.fp)
  return useWorkspace((state) => {
    const prefs = activeId ? state.preferences[activeId] : undefined
    return prefs?.fp === fp ? prefs : undefined
  })
}

const STORE_KEY = 'workspace.sessions'
const MAX_SESSIONS = 100
const defaultProjects: ProjectList = { items: [], loading: false, error: false, loaded: false }
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

export function visibleWorkspaceThreads(threads: WorkspaceThread[], desktopId: string | null, archived: Record<string, true>): WorkspaceThread[] {
  return desktopId ? threads.filter((thread) => !archived[archivedThreadKey(desktopId, thread.targetId, thread)]) : threads
}

export function filterProjects(projects: Project[], targets: Target[], query: string, targetId: string | null = null): Project[] {
  const scoped = targetId === null ? projects : projects.filter((project) => project.targetId === targetId)
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return scoped
  const byId = new Map(targets.map((target) => [target.id, target]))
  return scoped.filter((project) => {
    const target = byId.get(project.targetId)
    const host = target?.kind === 'direct' ? t('直连 {host}', { host: target.host })
      : target?.kind === 'ssh' ? t('远端 {host}', { host: target.host }) : undefined
    return [project.name, project.path, target?.name, host]
      .some((value) => value?.toLocaleLowerCase().includes(needle))
  })
}

/**
 * 会话按「需要关注程度」分档（参考 Orca 手机版 sort-stamps）：
 * 0 待审批 / 待输入 > 1 有新结果（未读） > 2 运行中 > 3 其余；看过的结果不再压过运行中的会话。
 */
export function threadAttentionTier(status: SessionStatus, unread = false): number {
  if (status === 'pending' || status === 'input') return 0
  if (status === 'unread' || (unread && status !== 'running')) return 1
  return status === 'running' ? 2 : 3
}

export function groupWorkspaceThreads(
  threads: WorkspaceThread[], projects: Project[], query: string, preferences?: WorkspacePreferences,
  /** 当前状态（含对话页实时状态）；省略时按列表缓存的状态计算。 */
  statusOf: (thread: WorkspaceThread) => SessionStatus = (thread) => recentThreadStatus(thread),
): WorkspaceGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  const groups = new Map<string, WorkspaceGroup>()
  const byId = new Map(projects.map((project) => [JSON.stringify([project.targetId, project.id]), project]))
  const tier = new Map(threads.map((thread) => [thread, threadAttentionTier(statusOf(thread), thread.unread)]))
  for (const entry of [...threads].sort((a, b) => tier.get(a)! - tier.get(b)! || b.updatedAt - a.updatedAt)) {
    const title = preferences?.threads[preferenceKey(entry)]?.title
    const thread = title ? { ...entry, title } : entry
    const key = JSON.stringify([thread.targetId, thread.projectId])
    const project = byId.get(key)
    if (!project) continue
    if (needle && ![thread.title, thread.preview, thread.agent, project.name, project.path].some((value) => value.toLocaleLowerCase().includes(needle))) continue
    const group = groups.get(key)
    if (group) group.threads.push(thread)
    else groups.set(key, { project, threads: [thread] })
  }
  return [...groups.values()].map((group) => ({ ...group, threads: group.threads.sort((a, b) =>
    Number(Boolean(preferences?.threads[preferenceKey(b)]?.pinned)) - Number(Boolean(preferences?.threads[preferenceKey(a)]?.pinned))) }))
}

/** 把分组列表摊平成会话键序列，供 applyThreadOrder 稳定排序用。 */
export function workspaceThreadOrder(groups: WorkspaceGroup[]): string[] {
  return groups.flatMap((group) => group.threads.map(workspaceThreadKey))
}

/**
 * 按已稳定的顺序重排分组：状态频繁变化时列表不跟着跳，等一段时间后再统一换成最新顺序。
 * 不在旧顺序里的新会话排在最前，分组按其中最靠前的会话排序。
 */
export function applyThreadOrder(groups: WorkspaceGroup[], order: readonly string[]): WorkspaceGroup[] {
  if (!order.length) return groups
  const rank = new Map(order.map((key, index) => [key, index]))
  const rankOf = (thread: WorkspaceThread) => rank.get(workspaceThreadKey(thread)) ?? -1
  return groups
    .map((group) => ({ ...group, threads: [...group.threads].sort((a, b) => rankOf(a) - rankOf(b)) }))
    .sort((a, b) => rankOf(a.threads[0]!) - rankOf(b.threads[0]!))
}

export function orderWorkspaceProjects(projects: Project[], ids: string[] = []): Project[] {
  const order = new Map(ids.map((id, index) => [id, index]))
  return [...projects].sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size))
}

function parsePreferences(raw: unknown): WorkspacePreferences | undefined {
  if (!raw || typeof raw !== 'object') return
  const value = raw as Partial<WorkspacePreferences>
  if (typeof value.fp !== 'string') return
  const threads = Object.fromEntries(Object.entries(value.threads ?? {}).flatMap(([key, item]) => {
    if (!item || typeof item !== 'object') return []
    const title = typeof item.title === 'string' ? item.title : undefined
    return title || item.pinned === true ? [[key, { title, pinned: item.pinned === true }]] : []
  }))
  const projectOrders = Object.fromEntries(Object.entries(value.projectOrders ?? {}).flatMap(([key, order]) =>
    Array.isArray(order) ? [[key, [...new Set(order.filter((id) => typeof id === 'string'))]]] : []))
  return { fp: value.fp, threads, projectOrders }
}

type WorkspaceState = {
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  threads: Record<string, WorkspaceThread[]>
  projects: Record<string, ProjectList>
  preferences: Record<string, WorkspacePreferences>
  loadProjects: (desktopId: string) => Promise<void>
}

const isThread = (row: unknown): row is WorkspaceThread => {
  if (!row || typeof row !== 'object') return false
  const value = row as Partial<WorkspaceThread>
  return typeof value.id === 'string' && typeof value.targetId === 'string' && typeof value.projectId === 'string'
    && typeof value.cwd === 'string' && typeof value.title === 'string' && typeof value.preview === 'string' && typeof value.updatedAt === 'number'
    && (value.agent === 'codex' || value.agent === 'claude' || value.agent === 'pi')
}

function mergeThreads(
  desktopId: string, previous: WorkspaceThread[], next: WorkspaceThread[], archived: Record<string, true>,
  /** 电脑刚返回的会话列表以服务器时间为准，旧缓存里被「点开即刷新」抬高的时间随之纠正。 */
  serverTime = false,
): WorkspaceThread[] {
  const merged = new Map(previous.map((item) => [workspaceThreadKey(item), item]))
  for (const item of next) {
    const key = workspaceThreadKey(item)
    const old = merged.get(key)
    const updatedAt = serverTime ? item.updatedAt : Math.max(old?.updatedAt ?? 0, item.updatedAt)
    merged.set(key, { ...old, ...item, activity: item.activity, updatedAt })
  }
  return visibleWorkspaceThreads([...merged.values()], desktopId, archived)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
}

function projectsFromThreads(threads: WorkspaceThread[]): Project[] {
  const projects = new Map<string, Pick<Project, 'id' | 'path' | 'targetId'>>()
  for (const { projectId: id, cwd: path, targetId } of threads) {
    if (path) projects.set(JSON.stringify([targetId, id]), { id, path, targetId })
  }
  return parseProjects([...projects.values()])
}

let storageRead = Promise.resolve()
let storageWrites = Promise.resolve()
function persistWorkspace() {
  const gateway = getGateway()
  const read = storageRead
  // 先合并旧缓存，避免启动阶段的第一次刷新覆盖其他电脑的历史。
  storageWrites = storageWrites.then(async () => {
    await read
    const { projects, threads, preferences } = useWorkspace.getState()
    const desktops = new Set([...Object.keys(projects), ...Object.keys(threads), ...Object.keys(preferences)])
    const stored = Object.fromEntries([...desktops].map((id) => {
      const rows = threads[id] ?? []
      return [id, {
        projects: projects[id]?.items ?? projectsFromThreads(rows),
        threads: rows.map(({ activity: _activity, ...thread }) => ({ ...thread, preview: '' })),
        preferences: preferences[id],
      }]
    }))
    await gateway.storageSet(STORE_KEY, JSON.stringify(stored))
  }).catch(() => undefined)
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tab: 'sessions',
  setTab: (tab) => {
    if (get().tab === tab) return
    const app = useApp.getState()
    if (app.page === 'workspace') app.cancelPendingNavigation()
    set({ tab })
  },
  threads: {},
  projects: {},
  preferences: {},
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
        if (get().projects[desktopId]) patch({ loading: false })
        return
      }
      const items = parseProjects(data)
      patch({ items, loading: false, loaded: true })
      persistWorkspace()
      if (get().tab !== 'sessions' || useApp.getState().activeId !== desktopId) return
      const discovered = await useApp.getState().discoverWorkspaceSessions(items)
      if (useApp.getState().activeId === desktopId && useApp.getState().connections.includes(connection) && discovered.length) {
        const archived = useApp.getState().archivedThreads
        set((state) => ({
          threads: { ...state.threads, [desktopId]: mergeThreads(desktopId, state.threads[desktopId] ?? [], discovered, archived) },
        }))
        persistWorkspace()
      }
    } catch {
      if (get().projects[desktopId]) patch({ loading: false, error: true })
    }
  },
}))

function changePreferences(desktopId: string, change: (current: WorkspacePreferences) => WorkspacePreferences): void {
  const fp = useApp.getState().connections.find((item) => item.id === desktopId)?.fp
  if (!fp) return
  useWorkspace.setState(({ preferences }) => {
    const saved = preferences[desktopId]
    const current = saved?.fp === fp ? saved : { fp, threads: {}, projectOrders: {} }
    return { preferences: { ...preferences, [desktopId]: change(current) } }
  })
  persistWorkspace()
}

export function changeThreadPreference(desktopId: string, thread: Pick<WorkspaceThread, 'targetId' | 'agent' | 'id'>, patch: ThreadPreference): void {
  changePreferences(desktopId, (current) => {
    const key = preferenceKey(thread)
    const threads = { ...current.threads, [key]: { ...current.threads[key], ...patch } }
    if (!threads[key]!.title && !threads[key]!.pinned) delete threads[key]
    return { ...current, threads }
  })
}

export function renameCachedThread(desktopId: string, thread: WorkspaceThread, title: string): void {
  useWorkspace.setState(({ threads }) => ({ threads: { ...threads, [desktopId]: (threads[desktopId] ?? []).map((item) =>
    preferenceKey(item) === preferenceKey(thread) ? { ...item, title } : item) } }))
  persistWorkspace()
}

export function moveWorkspaceProject(desktopId: string, project: Project, rows: Project[], offset: -1 | 1): void {
  const index = rows.findIndex(({ id }) => id === project.id)
  const neighbor = rows[index + offset]
  if (index < 0 || !neighbor) return
  const ids = rows.map(({ id }) => id)
  ids[index] = neighbor.id
  ids[index + offset] = project.id
  changePreferences(desktopId, (current) => ({ ...current, projectOrders: { ...current.projectOrders, [project.targetId]: ids } }))
}

/** 长按拖动后保存当前目标下的项目顺序（仅此手机）。 */
export function placeWorkspaceProject(desktopId: string, rows: Project[], from: number, to: number): void {
  const moved = rows[from]
  if (!moved || from === to || !rows[to]) return
  const ids = reorder(rows.map(({ id }) => id), from, to)
  changePreferences(desktopId, (current) => ({ ...current, projectOrders: { ...current.projectOrders, [moved.targetId]: ids } }))
}

export function startWorkspaceObserver(): () => void {
  let stop = false
  const removedDesktops = new Set<string>()
  storageRead = getGateway().storageGet(STORE_KEY).then((raw) => {
    if (!raw || stop) return
    const archived = useApp.getState().archivedThreads
    useWorkspace.setState((state) => {
      const threads = { ...state.threads }
      const projects = { ...state.projects }
      const preferences = { ...state.preferences }
      for (const [id, entry] of Object.entries(parseStoredRecord(raw))) {
        if (removedDesktops.has(id)) continue
        const snapshot = entry as { threads?: unknown; projects?: unknown; preferences?: unknown } | null
        const prefs = parsePreferences(snapshot?.preferences)
        if (prefs && !preferences[id]) preferences[id] = prefs
        const rows = Array.isArray(entry) ? entry : snapshot?.threads
        if (!Array.isArray(rows)) continue
        threads[id] = mergeThreads(id, rows.filter(isThread), threads[id] ?? [], archived)
        if (!projects[id]?.loaded) {
          // 旧版只存了会话，离线时用会话目录补出项目分组。
          const cached = Array.isArray(snapshot?.projects) ? parseProjects(snapshot.projects) : projectsFromThreads(threads[id])
          const items = new Map([...cached, ...(projects[id]?.items ?? [])]
            .map((project) => [JSON.stringify([project.targetId, project.id]), project]))
          projects[id] = { ...(projects[id] ?? defaultProjects), items: [...items.values()] }
        }
      }
      return { threads, projects, preferences }
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
    persistWorkspace()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', clearViewed)

  const unsubscribe = useApp.subscribe((now, before) => {
    if (now.connections !== before.connections) {
      // 重新配对换了证书指纹时，旧缓存可能属于另一台电脑，与草稿、队列一样不能带过去。
      const removed = before.connections.filter((item) => !now.connections.some((connection) => connection.id === item.id && connection.fp === item.fp))
      if (removed.length) {
        useWorkspace.setState((state) => {
          const threads = { ...state.threads }
          const projects = { ...state.projects }
          const preferences = { ...state.preferences }
          for (const item of removed) {
            removedDesktops.add(item.id)
            delete threads[item.id]
            delete projects[item.id]
            delete preferences[item.id]
          }
          return { threads, projects, preferences }
        })
        persistWorkspace()
      }
    }

    if (!now.activeId) return
    const { activeId: desktopId, selectedTargetId: targetId, selectedProjectId: projectId } = now
    const listed = targetId && projectId && now.threads !== before.threads
      ? now.threads.map((thread): WorkspaceThread => ({ ...thread, targetId, projectId, activity: thread.activity }))
      : []
    const snapshots: WorkspaceThread[] = []
    const desktopThreads = useWorkspace.getState().threads[desktopId] ?? []
    for (const cached of desktopThreads) {
      const key = sessionKey(cached.targetId, cached.agent)
      const current = now.sessions[key]?.state.threads[cached.id]
      const previous = before.activeId === desktopId ? before.sessions[key]?.state.threads[cached.id] : undefined
      const currentChat = visibleChat(now, cached)
      const activity = current?.activity
      // 首次读入历史时 activity 来自最后一轮的旧结果；只有列表里还在运行的会话，读入时已结束才算新结果。
      const changed = previous ? previous.activity !== activity : cached.activity !== undefined && isActiveThread(cached.activity)
      if (currentChat && cached.unread) {
        // 只清未读，不动排序时间（0 在合并时取较大值会被忽略）。
        snapshots.push({ ...cached, unread: false, updatedAt: 0 })
      } else if (!currentChat && changed && isThreadOutcome(activity)) {
        snapshots.push({ ...cached, activity, unread: true, updatedAt: Date.now() })
      }
    }

    if (listed.length || snapshots.length) {
      const project = now.projects.find((item) => item.targetId === targetId && item.id === projectId)
      useWorkspace.setState((state) => {
        // 先按服务器列表校正时间，再叠加本地的已读 / 新结果标记（新结果仍会把会话提到前面）。
        const fromServer = mergeThreads(desktopId, desktopThreads, listed, now.archivedThreads, true)
        const threads = { ...state.threads, [desktopId]: mergeThreads(desktopId, fromServer, snapshots, now.archivedThreads) }
        const list = state.projects[desktopId] ?? defaultProjects
        if (!project || list.items.some((item) => item.id === project.id && item.targetId === project.targetId)) return { threads }
        return { threads, projects: { ...state.projects, [desktopId]: { ...list, items: [...list.items, project] } } }
      })
      persistWorkspace()
    }
  })
  return () => {
    stop = true
    unsubscribe()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', clearViewed)
  }
}

export function workspaceProject(project: Project, desktopId: string) {
  const cached = useWorkspace.getState()
  const byId = new Map<string, Project>()
  for (const item of [...useApp.getState().projects, ...(cached.projects[desktopId]?.items ?? [])]) {
    if (item.targetId === project.targetId) byId.set(item.id, item)
  }
  byId.set(project.id, project)
  const threads = (cached.threads[desktopId] ?? [])
    .filter((thread) => thread.targetId === project.targetId && thread.projectId === project.id)
  return { project, projects: [...byId.values()], threads }
}

export async function showWorkspaceProject(project: Project): Promise<void> {
  const app = useApp.getState()
  if (app.activeId) await app.selectProject(project.id, workspaceProject(project, app.activeId))
}

export async function openWorkspaceThread(thread: WorkspaceThread, project: Project): Promise<boolean> {
  const app = useApp.getState()
  if (!app.activeId) return false
  return app.openThread(thread.id, thread.agent, workspaceProject(project, app.activeId))
}

export function recentThreadStatus(thread: WorkspaceThread, view?: Parameters<typeof sessionStatus>[0]) {
  return sessionStatus(view, thread.activity, thread.unread)
}

/**
 * 会话标题多由首条消息截断而来，预览往往与标题相同或只是它的延续；
 * 这种情况下再显示一行预览只是重复，不提供新信息。
 */
export function threadPreviewLine(title: string, preview: string): string {
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim()
  const body = squash(preview)
  if (!body) return ''
  const head = squash(title).replace(/(\.\.\.|…)$/, '').trim()
  return head && body.startsWith(head) ? '' : body
}

/** 远端 Windows 路径可能以 `/D:/code/x` 形式返回；显示成用户熟悉的 `D:\code\x`，打开时仍用原始路径。 */
export function displayPath(path: string): string {
  const windows = /^\/?([A-Za-z]:)([\\\/].*)?$/.exec(path)
  if (!windows) return path
  return `${windows[1]!.toUpperCase()}${(windows[2] ?? '\\').replace(/\//g, '\\')}`
}
