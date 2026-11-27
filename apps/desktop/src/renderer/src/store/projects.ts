import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'
import { useCodex } from './codex'

/** 单个目标上的项目列表：侧栏同时铺开多个目标，所以按目标分别缓存。 */
export type ProjectList = {
  projects: Project[]
  loading: boolean
  error: string | null
}

type ProjectsState = {
  byTarget: Record<string, ProjectList>
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
}

// 项目置顶只是本机显示偏好，不进后端。
const PIN_KEY = 'qn.projects.pinned'
const EMPTY: ProjectList = { projects: [], loading: false, error: null }

function readPinned(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PIN_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 置顶在前（按置顶先后），其余按最近打开。 */
export function sortProjects(projects: Project[], pinned: string[]): Project[] {
  const rank = (id: string) => {
    const index = pinned.indexOf(id)
    return index < 0 ? Number.POSITIVE_INFINITY : index
  }
  return [...projects].sort((a, b) => rank(a.id) - rank(b.id) || b.lastOpenedAt - a.lastOpenedAt)
}

/** 读某个目标的项目列表（未加载时返回同一个空列表，引用稳定）。 */
export function projectListOf(state: Pick<ProjectsState, 'byTarget'>, targetId: string): ProjectList {
  return state.byTarget[targetId] ?? EMPTY
}

type Patch = Partial<Pick<ProjectsState, 'byTarget' | 'targetId' | 'selectedId' | 'pinned'>>

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

export const useProjects = create<ProjectsState>((set, get) => {
  const patch = (fn: (state: ProjectsState) => Patch) => set((state) => withMirror(state, fn(state)))
  const replaceProject = (saved: Project) =>
    patch((state) =>
      updateList(state, saved.targetId, (list) => ({
        ...list,
        projects: sortProjects(
          list.projects.map((item) => (item.id === saved.id ? saved : item)),
          state.pinned,
        ),
      })),
    )
  const setError = (targetId: string, error: string) =>
    patch((state) => updateList(state, targetId, (list) => ({ ...list, error })))

  return {
    byTarget: {},
    targetId: null,
    projects: [],
    loading: false,
    error: null,
    selectedId: null,
    pinned: readPinned(),

    load: async (targetId) => {
      patch((state) => updateList(state, targetId, (list) => ({ ...list, loading: true, error: null })))
      try {
        const projects = await call('projects.list', { targetId })
        patch((state) => {
          const next = updateList(state, targetId, () => ({
            projects: sortProjects(projects, state.pinned),
            loading: false,
            error: null,
          }))
          // 当前项目被别处删掉时取消选中。
          const lost =
            state.targetId === targetId &&
            state.selectedId !== null &&
            !projects.some((item) => item.id === state.selectedId)
          return lost ? { ...next, selectedId: null } : next
        })
      } catch (err) {
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
        replaceProject(saved)
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
      const project = Object.values(get().byTarget)
        .flatMap((list) => list.projects)
        .find((item) => item.id === id)
      const targetId = project?.targetId ?? get().targetId
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
        replaceProject(saved)
      } catch (err) {
        setError(project.targetId, friendlyError(err, '重命名项目失败'))
      }
    },

    togglePin: (id) => {
      patch((state) => {
        const pinned = state.pinned.includes(id) ? state.pinned.filter((item) => item !== id) : [...state.pinned, id]
        try {
          localStorage.setItem(PIN_KEY, JSON.stringify(pinned))
        } catch {
          // 存储不可用时只在本次运行内生效。
        }
        const byTarget = Object.fromEntries(
          Object.entries(state.byTarget).map(([key, list]) => [key, { ...list, projects: sortProjects(list.projects, pinned) }]),
        )
        return { pinned, byTarget }
      })
    },
  }
})
