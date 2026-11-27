import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'
import { useCodex } from './codex'

export type ProjectPlacement = 'before' | 'after'

/** 单个目标上的项目列表：侧栏同时铺开多个目标，所以按目标分别缓存。 */
export type ProjectList = {
  projects: Project[]
  loading: boolean
  error: string | null
}

type ProjectsState = {
  byTarget: Record<string, ProjectList>
  /** 各目标里普通项目的手动排序（含置顶项目原位置，取消置顶时据此恢复）。 */
  orderByTarget: Map<string, string[]>
  /** 当前活动目标（与 useTargets.selectedId 同步），下面三个字段是它的列表镜像，供主区直接读取。 */
  targetId: string | null
  projects: Project[]
  loading: boolean
  error: string | null
  /** 当前打开的项目，只会属于活动目标。 */
  selectedId: string | null
  load: (targetId: string) => Promise<void>
  /** 重新加载所有已加载过的目标（导入旧版数据后用）。 */
  reloadAll: () => Promise<void>
  setActiveTarget: (targetId: string) => void
  select: (project: Project) => Promise<void>
  add: (targetId: string, path: string) => Promise<Project | null>
  remove: (id: string) => Promise<void>
  rename: (project: Project, name: string) => Promise<void>
  pinned: string[]
  togglePin: (id: string) => void
  move: (id: string, anchorId: string, placement: ProjectPlacement) => void
}

// 项目置顶与排序只是本机显示偏好，不进后端。
const PIN_KEY = 'qn.projects.pinned'
const orderKey = (targetId: string) => `qn.projects.order.${targetId}`
const EMPTY: ProjectList = { projects: [], loading: false, error: null }
// 每个目标各自计数，迟到的旧列表响应不能覆盖新结果。
const loadRevisions = new Map<string, number>()

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

/** 读某个目标的项目列表（未加载时返回同一个空列表，引用稳定）。 */
export function projectListOf(state: Pick<ProjectsState, 'byTarget'>, targetId: string): ProjectList {
  return state.byTarget[targetId] ?? EMPTY
}

type Patch = Partial<Pick<ProjectsState, 'byTarget' | 'orderByTarget' | 'targetId' | 'selectedId' | 'pinned'>>

/** 写入 byTarget / 活动目标后，同步活动目标的镜像字段。 */
function withMirror(state: ProjectsState, patch: Patch): Partial<ProjectsState> {
  const byTarget = patch.byTarget ?? state.byTarget
  const targetId = patch.targetId !== undefined ? patch.targetId : state.targetId
  const list = targetId ? byTarget[targetId] ?? EMPTY : EMPTY
  return { ...patch, projects: list.projects, loading: list.loading, error: list.error }
}

function updateList(state: ProjectsState, targetId: string, update: (list: ProjectList) => ProjectList): Patch {
  return { byTarget: { ...state.byTarget, [targetId]: update(state.byTarget[targetId] ?? EMPTY) } }
}

function targetOfProject(state: ProjectsState, id: string): string | undefined {
  return Object.entries(state.byTarget).find(([, list]) => list.projects.some((item) => item.id === id))?.[0]
}

export const useProjects = create<ProjectsState>((set, get) => {
  const patch = (fn: (state: ProjectsState) => Patch) => set((state) => withMirror(state, fn(state)))
  // 保存只回写字段，不重新排序：打开项目不应打乱用户拖好的顺序。
  const replaceProject = (saved: Project, fields: (saved: Project, item: Project) => Project) =>
    patch((state) =>
      updateList(state, saved.targetId, (list) => ({
        ...list,
        projects: list.projects.map((item) => (item.id === saved.id ? fields(saved, item) : item)),
      })),
    )
  const setError = (targetId: string, error: string) =>
    patch((state) => updateList(state, targetId, (list) => ({ ...list, error })))

  return {
    byTarget: {},
    orderByTarget: new Map(),
    targetId: null,
    projects: [],
    loading: false,
    error: null,
    selectedId: null,
    pinned: readIds(PIN_KEY),

    load: async (targetId) => {
      const revision = (loadRevisions.get(targetId) ?? 0) + 1
      loadRevisions.set(targetId, revision)
      patch((state) => updateList(state, targetId, (list) => ({ ...list, loading: true, error: null })))
      try {
        const projects = await call('projects.list', { targetId })
        if (loadRevisions.get(targetId) !== revision) return
        patch((state) => {
          const ordered = orderProjects(projects, state.orderByTarget.get(targetId) ?? readIds(orderKey(targetId)))
          const next: Patch = {
            ...updateList(state, targetId, () => ({
              projects: orderProjects(ordered, state.pinned),
              loading: false,
              error: null,
            })),
            orderByTarget: rememberOrder(state.orderByTarget, targetId, ordered.map(({ id }) => id)),
          }
          // 当前项目被别处删掉时取消选中。
          const lost =
            state.targetId === targetId &&
            state.selectedId !== null &&
            !projects.some((item) => item.id === state.selectedId)
          return lost ? { ...next, selectedId: null } : next
        })
      } catch (err) {
        if (loadRevisions.get(targetId) !== revision) return
        patch((state) =>
          updateList(state, targetId, () => ({
            projects: [],
            loading: false,
            error: friendlyError(err, '加载项目失败'),
          })),
        )
      }
    },

    reloadAll: async () => {
      await Promise.all(Object.keys(get().byTarget).map((targetId) => get().load(targetId)))
    },

    setActiveTarget: (targetId) => {
      patch((state) => {
        if (state.targetId === targetId) return {}
        const keep =
          state.selectedId !== null &&
          projectListOf(state, targetId).projects.some((item) => item.id === state.selectedId)
        return { targetId, selectedId: keep ? state.selectedId : null }
      })
      if (!get().byTarget[targetId]) void get().load(targetId)
    },

    select: async (project) => {
      patch((state) => ({
        targetId: project.targetId,
        selectedId: project.id,
        ...updateList(state, project.targetId, (list) => ({ ...list, error: null })),
      }))
      useCodex.getState().setContext(project.targetId, project.path, true)
      // 打开项目时刷新 lastOpenedAt；后端暂未实现时仍然允许进入对话。
      try {
        const saved = await call('projects.save', {
          id: project.id,
          targetId: project.targetId,
          name: project.name,
          path: project.path,
        })
        replaceProject(saved, (value, item) => ({ ...item, lastOpenedAt: value.lastOpenedAt }))
      } catch (err) {
        setError(project.targetId, friendlyError(err, '刷新项目时间失败'))
      }
    },

    add: async (targetId, path) => {
      try {
        const project = await call('projects.save', { targetId, path })
        await get().load(targetId)
        await get().select(project)
        return project
      } catch (err) {
        setError(targetId, friendlyError(err, '添加项目失败'))
        return null
      }
    },

    remove: async (id) => {
      const targetId = targetOfProject(get(), id) ?? get().targetId
      const wasSelected = get().selectedId === id
      try {
        await call('projects.remove', { id })
        if (targetId) await get().load(targetId)
        if (wasSelected) {
          patch(() => ({ selectedId: null }))
          useCodex.getState().setContext(targetId, null)
        }
      } catch (err) {
        if (targetId) setError(targetId, friendlyError(err, '删除项目失败'))
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
        replaceProject(saved, (value) => value)
      } catch (err) {
        setError(project.targetId, friendlyError(err, '重命名项目失败'))
      }
    },

    togglePin: (id) => {
      patch((state) => {
        const pinned = state.pinned.includes(id) ? state.pinned.filter((item) => item !== id) : [...state.pinned, id]
        writeIds(PIN_KEY, pinned)
        const byTarget = Object.fromEntries(
          Object.entries(state.byTarget).map(([key, list]) => [
            key,
            { ...list, projects: orderProjects(list.projects, [...pinned, ...(state.orderByTarget.get(key) ?? [])]) },
          ]),
        )
        return { pinned, byTarget }
      })
    },

    move: (id, anchorId, placement) => {
      patch((state) => {
        const targetId = targetOfProject(state, id)
        if (!targetId || targetOfProject(state, anchorId) !== targetId) return {}
        const { pinned, orderByTarget } = state
        const projects = projectListOf(state, targetId).projects
        const isPinned = pinned.includes(id)
        if (isPinned !== pinned.includes(anchorId)) return {}
        const order = orderByTarget.get(targetId) ?? projects.map((item) => item.id)
        const setList = (next: Project[]) => updateList(state, targetId, (list) => ({ ...list, projects: next }))
        if (isPinned) {
          const nextPinned = moveId(pinned, id, anchorId, placement)
          if (nextPinned === pinned) return {}
          writeIds(PIN_KEY, nextPinned)
          return { pinned: nextPinned, ...setList(orderProjects(projects, [...nextPinned, ...order])) }
        }
        const unpinned = order.filter((entry) => !pinned.includes(entry))
        const moved = moveId(unpinned, id, anchorId, placement)
        if (moved === unpinned) return {}
        // 拖动普通项目时保留置顶项目在原顺序中的位置，供取消置顶时恢复。
        let index = 0
        const nextOrder = order.map((entry) => (pinned.includes(entry) ? entry : moved[index++]!))
        return {
          ...setList(orderProjects(projects, [...pinned, ...nextOrder])),
          orderByTarget: rememberOrder(orderByTarget, targetId, nextOrder),
        }
      })
    },
  }
})
