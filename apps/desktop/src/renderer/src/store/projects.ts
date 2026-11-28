import { t } from '@qn/codex-client'
import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'
import { useCodex } from './codex'
import { useProjectTrust } from './projectTrust'
import { useTargets } from './targets'

export type ProjectPlacement = 'before' | 'after'

/** 单个目标上的项目列表：侧栏同时铺开多个目标，所以按目标分别缓存。 */
export type ProjectList = {
  projects: Project[]
  loading: boolean
  error: string | null
}

type ProjectTreeState = { projectId: string | null; expandedIds: string[] }

type ProjectsState = {
  byTarget: Record<string, ProjectList>
  /** 各目标里普通项目的手动排序（含置顶项目原位置，取消置顶时据此恢复）。 */
  orderByTarget: Map<string, string[]>
  /** 各目标上次打开的项目与展开的项目，重载后恢复。 */
  treeByTarget: Map<string, ProjectTreeState>
  /** 显示全部会话（而非最近几条）的项目。 */
  fullThreadLists: string[]
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
  setExpanded: (project: Project, expanded: boolean) => void
  setShowAllThreads: (id: string, showAll: boolean) => void
  /** 收起某个目标下所有项目的会话列表。 */
  collapseAll: (targetId: string) => void
  /** trusted 为用户在信任确认框里的选择。 */
  add: (targetId: string, path: string, trusted: boolean) => Promise<Project | null>
  setTrusted: (project: Project, trusted: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  rename: (project: Project, name: string) => Promise<void>
  pinned: string[]
  togglePin: (id: string) => void
  /** 隐藏项目：写入后端 projects.json，电脑侧栏与手机端都不显示，记录与会话保留。 */
  setHidden: (project: Project, hidden: boolean) => Promise<void>
  move: (id: string, anchorId: string, placement: ProjectPlacement) => void
  /** 把某个目标的普通项目按最近打开时间重排（置顶组保持手动顺序）。 */
  sortByRecent: (targetId: string) => void
}

// 项目置顶、排序与展开状态只是本机显示偏好，不进后端。
const PIN_KEY = 'qn.projects.pinned'
const FULL_THREAD_LISTS_KEY = 'qn.projects.fullThreadLists'
const orderKey = (targetId: string) => `qn.projects.order.${targetId}`
const treeKey = (targetId: string) => `qn.projects.tree.${targetId}`
const EMPTY: ProjectList = { projects: [], loading: false, error: null }
// 每个目标各自计数，迟到的旧列表响应不能覆盖新结果。
const loadRevisions = new Map<string, number>()

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

/** 读某个目标的项目列表（未加载时返回同一个空列表，引用稳定）。 */
export function projectListOf(state: Pick<ProjectsState, 'byTarget'>, targetId: string): ProjectList {
  return state.byTarget[targetId] ?? EMPTY
}

type Patch = Partial<Pick<ProjectsState, 'byTarget' | 'orderByTarget' | 'treeByTarget' | 'targetId' | 'selectedId' | 'pinned'>>

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

/** 去掉已删除项目的展开记录；当前项目已不存在时清空它。 */
function pruneTree(trees: Map<string, ProjectTreeState>, targetId: string, projects: Project[]) {
  const saved = trees.get(targetId) ?? readTree(targetId)
  if (!saved) return trees
  const exists = (id: string) => projects.some((project) => project.id === id)
  const expandedIds = saved.expandedIds.filter(exists)
  const projectId = saved.projectId && exists(saved.projectId) ? saved.projectId : null
  if (!projectId && !expandedIds.length) return rememberTree(trees, targetId)
  if (projectId !== saved.projectId || expandedIds.length !== saved.expandedIds.length) {
    return rememberTree(trees, targetId, { projectId, expandedIds })
  }
  return trees.has(targetId) ? trees : new Map(trees).set(targetId, saved)
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

  /** 活动目标还没打开项目时，恢复它上次打开的项目（不刷新 lastOpenedAt）。 */
  const restoreSelection = (targetId: string) => {
    const state = get()
    if (state.targetId !== targetId || state.selectedId !== null) return
    const projectId = state.treeByTarget.get(targetId)?.projectId
    const project = projectListOf(state, targetId).projects.find(({ id }) => id === projectId)
    if (!project) return
    patch(() => ({ selectedId: project.id }))
    const chat = useCodex.getState()
    if (chat.currentTargetId !== targetId || chat.currentCwd !== project.path) {
      chat.setContext(targetId, project.path, useTargets.getState().states[targetId]?.state === 'ready')
    }
  }

  return {
    byTarget: {},
    orderByTarget: new Map(),
    treeByTarget: new Map(),
    fullThreadLists: readIds(FULL_THREAD_LISTS_KEY),
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
        useProjectTrust.getState().setTargetProjects(targetId, projects)
        patch((state) => {
          const ordered = orderProjects(projects, state.orderByTarget.get(targetId) ?? readIds(orderKey(targetId)))
          const next: Patch = {
            ...updateList(state, targetId, () => ({
              projects: orderProjects(ordered, state.pinned),
              loading: false,
              error: null,
            })),
            orderByTarget: rememberOrder(state.orderByTarget, targetId, ordered.map(({ id }) => id)),
            treeByTarget: pruneTree(state.treeByTarget, targetId, projects),
          }
          // 当前项目被别处删掉时取消选中。
          const lost =
            state.targetId === targetId &&
            state.selectedId !== null &&
            !projects.some((item) => item.id === state.selectedId)
          return lost ? { ...next, selectedId: null } : next
        })
        restoreSelection(targetId)
      } catch (err) {
        if (loadRevisions.get(targetId) !== revision) return
        patch((state) =>
          updateList(state, targetId, () => ({
            projects: [],
            loading: false,
            error: friendlyError(err, t('加载项目失败')),
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
      else restoreSelection(targetId)
    },

    select: async (project) => {
      patch((state) => {
        const { id, targetId } = project
        const expandedIds = state.treeByTarget.get(targetId)?.expandedIds ?? readTree(targetId)?.expandedIds ?? []
        return {
          targetId,
          selectedId: id,
          ...updateList(state, targetId, (list) => ({ ...list, error: null })),
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
        replaceProject(saved, (value, item) => ({ ...item, lastOpenedAt: value.lastOpenedAt }))
      } catch (err) {
        setError(project.targetId, friendlyError(err, t('刷新项目时间失败')))
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

    collapseAll: (targetId) => {
      const { treeByTarget } = get()
      // 分组折叠时项目树可能还没加载过，回退读本机记录。
      const tree = treeByTarget.get(targetId) ?? readTree(targetId)
      if (!tree?.expandedIds.length) return
      set({ treeByTarget: rememberTree(treeByTarget, targetId, { ...tree, expandedIds: [] }) })
    },

    add: async (targetId, path, trusted) => {
      try {
        const project = await call('projects.save', { targetId, path, trusted })
        await get().load(targetId)
        await get().select(project)
        return project
      } catch (err) {
        setError(targetId, friendlyError(err, t('添加项目失败')))
        return null
      }
    },

    remove: async (id) => {
      const targetId = targetOfProject(get(), id) ?? get().targetId
      const wasSelected = get().selectedId === id
      try {
        await call('projects.remove', { id })
        get().setShowAllThreads(id, false)
        // 删除即不再保留任何记录：清掉本机置顶里的残留 id（手动排序由 load 重算）。
        patch((state) => {
          if (!state.pinned.includes(id)) return {}
          const pinned = state.pinned.filter((item) => item !== id)
          writeIds(PIN_KEY, pinned)
          return { pinned }
        })
        if (targetId) await get().load(targetId)
        if (wasSelected) {
          patch(() => ({ selectedId: null }))
          useCodex.getState().setContext(targetId, null)
        }
      } catch (err) {
        if (targetId) setError(targetId, friendlyError(err, t('删除项目失败')))
      }
    },

    setTrusted: async (project, trusted) => {
      if (project.trusted === trusted) return
      try {
        await call('projects.save', {
          id: project.id,
          targetId: project.targetId,
          name: project.name,
          path: project.path,
          trusted,
        })
        // 重新加载以同步信任索引，codex/run 两侧立即按新状态拦截。
        await get().load(project.targetId)
      } catch (err) {
        setError(project.targetId, friendlyError(err, t('更新项目信任失败')))
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
        setError(project.targetId, friendlyError(err, t('重命名项目失败')))
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

    sortByRecent: (targetId) => {
      patch((state) => {
        const projects = projectListOf(state, targetId).projects
        const sorted = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.id.localeCompare(b.id))
        const order = sorted.map(({ id }) => id)
        return {
          ...updateList(state, targetId, (list) => ({ ...list, projects: orderProjects(sorted, state.pinned) })),
          orderByTarget: rememberOrder(state.orderByTarget, targetId, order),
        }
      })
    },

    setHidden: async (project, hidden) => {
      if ((project.hidden === true) === hidden) return
      try {
        const saved = await call('projects.save', {
          id: project.id,
          targetId: project.targetId,
          name: project.name,
          path: project.path,
          hidden,
        })
        replaceProject(saved, (value, item) => ({ ...item, hidden: value.hidden === true }))
      } catch (err) {
        setError(project.targetId, friendlyError(err, t('更新项目显示状态失败')))
      }
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
