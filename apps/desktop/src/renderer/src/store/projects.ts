import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'
import { useCodex } from './codex'
import { useTargets } from './targets'

export type ProjectPlacement = 'before' | 'after'

type ProjectTreeState = { projectId: string | null; expandedIds: string[] }

type ProjectsState = {
  projects: Project[]
  orderByTarget: Map<string, string[]>
  treeByTarget: Map<string, ProjectTreeState>
  fullThreadLists: string[]
  targetId: string | null
  selectedId: string | null
  loading: boolean
  error: string | null
  load: (targetId: string) => Promise<void>
  select: (project: Project) => Promise<void>
  setExpanded: (project: Project, expanded: boolean) => void
  setShowAllThreads: (id: string, showAll: boolean) => void
  add: (targetId: string, path: string) => Promise<Project | null>
  remove: (id: string) => Promise<void>
  rename: (project: Project, name: string) => Promise<void>
  pinned: string[]
  togglePin: (id: string) => void
  move: (id: string, anchorId: string, placement: ProjectPlacement) => void
}

const PIN_KEY = 'qn.projects.pinned'
const FULL_THREAD_LISTS_KEY = 'qn.projects.fullThreadLists'
const orderKey = (targetId: string) => `qn.projects.order.${targetId}`
const treeKey = (targetId: string) => `qn.projects.tree.${targetId}`
let loadRevision = 0

function readTree(targetId: string): ProjectTreeState | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(treeKey(targetId)) ?? 'null')
    if (value && typeof value === 'object' && 'projectId' in value
      && (typeof value.projectId === 'string' || value.projectId === null)) {
      const { projectId } = value
      if ('expandedIds' in value && Array.isArray(value.expandedIds)) {
        return { projectId, expandedIds: value.expandedIds.filter((id): id is string => typeof id === 'string') }
      }
      // 旧版每个目标只保存了当前项目的折叠状态。
      if (projectId && 'collapsed' in value && typeof value.collapsed === 'boolean') {
        return { projectId, expandedIds: value.collapsed ? [] : [projectId] }
      }
    }
  } catch {
    // 存储不可用时仍可手动展开项目。
  }
}

function rememberTree(trees: Map<string, ProjectTreeState>, targetId: string, tree?: ProjectTreeState) {
  const next = new Map(trees)
  if (tree) next.set(targetId, tree)
  else next.delete(targetId)
  try {
    if (tree) localStorage.setItem(treeKey(targetId), JSON.stringify(tree))
    else localStorage.removeItem(treeKey(targetId))
  } catch {
    // 存储不可用时仍保留本次运行的展开状态。
  }
  return next
}

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // 存储不可用时保留本次运行的顺序。
  }
}

// 首次加载沿用后端顺序，之后只把新增项目接在已保存的项目后面。
function orderProjects(projects: Project[], order: string[]): Project[] {
  const remaining = new Map(projects.map((project) => [project.id, project]))
  const ordered: Project[] = []
  for (const id of order) {
    const project = remaining.get(id)
    if (!project) continue
    ordered.push(project)
    remaining.delete(id)
  }
  return [...ordered, ...remaining.values()]
}

function rememberOrder(orders: Map<string, string[]>, targetId: string, order: string[]): Map<string, string[]> {
  const previous = orders.get(targetId)
  if (previous?.length === order.length && previous.every((id, index) => id === order[index])) return orders
  writeIds(orderKey(targetId), order)
  return new Map(orders).set(targetId, order)
}

function moveId(order: string[], id: string, anchorId: string, placement: ProjectPlacement): string[] {
  if (id === anchorId || !order.includes(id) || !order.includes(anchorId)) return order
  const next = order.filter((entry) => entry !== id)
  next.splice(next.indexOf(anchorId) + (placement === 'after' ? 1 : 0), 0, id)
  return next.every((entry, index) => entry === order[index]) ? order : next
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  orderByTarget: new Map(),
  treeByTarget: new Map(),
  fullThreadLists: readIds(FULL_THREAD_LISTS_KEY),
  targetId: null,
  selectedId: null,
  loading: false,
  error: null,
  pinned: readIds(PIN_KEY),

  load: async (targetId) => {
    const revision = ++loadRevision
    set((state) => ({
      targetId,
      projects: state.targetId === targetId ? state.projects : [],
      selectedId: state.targetId === targetId ? state.selectedId : null,
      loading: true,
      error: null,
    }))
    try {
      const projects = await call('projects.list', { targetId })
      if (revision !== loadRevision) return
      const state = get()
      const savedTree = state.treeByTarget.get(targetId) ?? readTree(targetId)
      const selected = projects.find(({ id }) => id === (state.selectedId ?? savedTree?.projectId))
      const ordered = orderProjects(projects, state.orderByTarget.get(targetId) ?? readIds(orderKey(targetId)))
      let treeByTarget = state.treeByTarget
      if (savedTree) {
        const expandedIds = savedTree.expandedIds.filter((id) => projects.some((project) => project.id === id))
        const projectId = selected?.id ?? null
        if (!projectId && !expandedIds.length) treeByTarget = rememberTree(treeByTarget, targetId)
        else if (projectId !== savedTree.projectId || expandedIds.length !== savedTree.expandedIds.length) {
          treeByTarget = rememberTree(treeByTarget, targetId, { projectId, expandedIds })
        } else if (!treeByTarget.has(targetId)) treeByTarget = new Map(treeByTarget).set(targetId, savedTree)
      }
      set({
        projects: orderProjects(ordered, state.pinned),
        orderByTarget: rememberOrder(state.orderByTarget, targetId, ordered.map(({ id }) => id)),
        selectedId: selected?.id ?? null,
        treeByTarget,
        loading: false,
      })
      if (selected && selected.id !== state.selectedId) {
        const chat = useCodex.getState()
        const ready = useTargets.getState().states[targetId]?.state === 'ready'
        if (chat.currentTargetId !== targetId || chat.currentCwd !== selected.path) {
          chat.setContext(targetId, selected.path, ready)
        }
      }
    } catch (err) {
      if (revision !== loadRevision) return
      set({ projects: [], selectedId: null, loading: false, error: friendlyError(err, '加载项目失败') })
    }
  },

  select: async (project) => {
    set((state) => {
      const { id, targetId } = project
      const expandedIds = state.treeByTarget.get(targetId)?.expandedIds ?? readTree(targetId)?.expandedIds ?? []
      return {
        selectedId: id,
        error: null,
        treeByTarget: rememberTree(state.treeByTarget, targetId, {
          projectId: id,
          expandedIds: expandedIds.includes(id) ? expandedIds : [...expandedIds, id],
        }),
      }
    })
    useCodex.getState().setContext(project.targetId, project.path, true)
    // 打开项目时刷新 lastOpenedAt；后端暂未实现时仍然允许进入对话。
    try {
      const saved = await call('projects.save', {
        id: project.id,
        targetId: project.targetId,
        name: project.name,
        path: project.path,
      })
      set((state) => ({
        projects: state.projects.map((item) => item.id === saved.id
          ? { ...item, lastOpenedAt: saved.lastOpenedAt }
          : item),
      }))
    } catch (err) {
      set({ error: friendlyError(err, '刷新项目时间失败') })
    }
  },

  setExpanded: ({ targetId, id }, expanded) => {
    const { treeByTarget } = get()
    const tree = treeByTarget.get(targetId) ?? readTree(targetId) ?? { projectId: null, expandedIds: [] }
    if (tree.expandedIds.includes(id) === expanded) return
    const expandedIds = expanded ? [...tree.expandedIds, id] : tree.expandedIds.filter((item) => item !== id)
    set({ treeByTarget: rememberTree(treeByTarget, targetId, { ...tree, expandedIds }) })
  },

  setShowAllThreads: (id, showAll) => {
    const { fullThreadLists } = get()
    if (fullThreadLists.includes(id) === showAll) return
    const next = showAll ? [...fullThreadLists, id] : fullThreadLists.filter((item) => item !== id)
    writeIds(FULL_THREAD_LISTS_KEY, next)
    set({ fullThreadLists: next })
  },

  add: async (targetId, path) => {
    try {
      const project = await call('projects.save', { targetId, path })
      if (get().targetId === targetId) {
        await get().load(targetId)
        if (get().targetId === targetId) await get().select(project)
      }
      return project
    } catch (err) {
      set({ error: friendlyError(err, '添加项目失败') })
      return null
    }
  },

  remove: async (id) => {
    const targetId = get().targetId
    const wasSelected = get().selectedId === id
    try {
      await call('projects.remove', { id })
      get().setShowAllThreads(id, false)
      if (targetId && get().targetId === targetId) {
        await get().load(targetId)
        if (wasSelected && get().targetId === targetId && get().selectedId === null) {
          useCodex.getState().setContext(targetId, null)
        }
      }
    } catch (err) {
      set({ error: friendlyError(err, '删除项目失败') })
    }
  },

  rename: async (project, name) => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === project.name) return
    try {
      const saved = await call('projects.save', {
        id: project.id,
        targetId: project.targetId,
        name: trimmed,
        path: project.path,
      })
      set((state) => ({
        projects: state.projects.map((item) => (item.id === saved.id ? saved : item)),
      }))
    } catch (err) {
      set({ error: friendlyError(err, '重命名项目失败') })
    }
  },

  togglePin: (id) => {
    set((state) => {
      const pinned = state.pinned.includes(id) ? state.pinned.filter((item) => item !== id) : [...state.pinned, id]
      writeIds(PIN_KEY, pinned)
      const order = state.targetId ? state.orderByTarget.get(state.targetId) ?? [] : []
      return { pinned, projects: orderProjects(state.projects, [...pinned, ...order]) }
    })
  },

  move: (id, anchorId, placement) => {
    set((state) => {
      const { targetId, projects, pinned, orderByTarget } = state
      if (!targetId || !projects.some((item) => item.id === id) || !projects.some((item) => item.id === anchorId)) return state
      const isPinned = pinned.includes(id)
      if (isPinned !== pinned.includes(anchorId)) return state
      const order = orderByTarget.get(targetId) ?? projects.map((item) => item.id)
      if (isPinned) {
        const nextPinned = moveId(pinned, id, anchorId, placement)
        if (nextPinned === pinned) return state
        writeIds(PIN_KEY, nextPinned)
        return { pinned: nextPinned, projects: orderProjects(projects, [...nextPinned, ...order]) }
      }
      const unpinned = order.filter((entry) => !pinned.includes(entry))
      const moved = moveId(unpinned, id, anchorId, placement)
      if (moved === unpinned) return state
      // 拖动普通项目时保留置顶项目在原顺序中的位置，供取消置顶时恢复。
      let index = 0
      const nextOrder = order.map((entry) => pinned.includes(entry) ? entry : moved[index++]!)
      return {
        projects: orderProjects(projects, [...pinned, ...nextOrder]),
        orderByTarget: rememberOrder(orderByTarget, targetId, nextOrder),
      }
    })
  },
}))
