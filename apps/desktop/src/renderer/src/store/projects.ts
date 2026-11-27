import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'
import { useCodex } from './codex'

export type ProjectPlacement = 'before' | 'after'

type ProjectsState = {
  projects: Project[]
  orderByTarget: Map<string, string[]>
  targetId: string | null
  selectedId: string | null
  loading: boolean
  error: string | null
  load: (targetId: string) => Promise<void>
  select: (project: Project) => Promise<void>
  add: (targetId: string, path: string) => Promise<Project | null>
  remove: (id: string) => Promise<void>
  rename: (project: Project, name: string) => Promise<void>
  pinned: string[]
  togglePin: (id: string) => void
  move: (id: string, anchorId: string, placement: ProjectPlacement) => void
}

const PIN_KEY = 'qn.projects.pinned'
const orderKey = (targetId: string) => `qn.projects.order.${targetId}`
let loadRevision = 0

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
      set((state) => {
        const ordered = orderProjects(projects, state.orderByTarget.get(targetId) ?? readIds(orderKey(targetId)))
        return {
          projects: orderProjects(ordered, state.pinned),
          orderByTarget: rememberOrder(state.orderByTarget, targetId, ordered.map(({ id }) => id)),
          selectedId: projects.some((project) => project.id === state.selectedId)
            ? state.selectedId
            : null,
          loading: false,
        }
      })
    } catch (err) {
      if (revision !== loadRevision) return
      set({ projects: [], selectedId: null, loading: false, error: friendlyError(err, '加载项目失败') })
    }
  },

  select: async (project) => {
    set({ selectedId: project.id, error: null })
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
