import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'
import { useCodex } from './codex'

type ProjectsState = {
  projects: Project[]
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
}

// 项目置顶只是本机显示偏好，不进后端。
const PIN_KEY = 'qn.projects.pinned'

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

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  targetId: null,
  selectedId: null,
  loading: false,
  error: null,
  pinned: readPinned(),

  load: async (targetId) => {
    set((state) => ({
      targetId,
      selectedId: state.targetId === targetId ? state.selectedId : null,
      loading: true,
      error: null,
    }))
    try {
      const projects = await call('projects.list', { targetId })
      set((state) => ({
        projects: sortProjects(projects, state.pinned),
        selectedId: projects.some((project) => project.id === state.selectedId)
          ? state.selectedId
          : null,
        loading: false,
      }))
    } catch (err) {
      set({ projects: [], selectedId: null, loading: false, error: friendlyError(err, '加载项目失败') })
    }
  },

  select: async (project) => {
    set({ selectedId: project.id, error: null })
    // 打开项目时刷新 lastOpenedAt；后端暂未实现时仍然允许进入对话。
    try {
      const saved = await call('projects.save', {
        id: project.id,
        targetId: project.targetId,
        name: project.name,
        path: project.path,
      })
      set((state) => ({
        projects: sortProjects(
          state.projects.map((item) => (item.id === saved.id ? saved : item)),
          state.pinned,
        ),
      }))
    } catch (err) {
      set({ error: friendlyError(err, '刷新项目时间失败') })
    }
    useCodex.getState().setContext(project.targetId, project.path, true)
  },

  add: async (targetId, path) => {
    try {
      const project = await call('projects.save', { targetId, path })
      await get().load(targetId)
      await get().select(project)
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
      if (targetId) await get().load(targetId)
      if (wasSelected) useCodex.getState().setContext(targetId, null)
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
        projects: sortProjects(
          state.projects.map((item) => (item.id === saved.id ? saved : item)),
          state.pinned,
        ),
      }))
    } catch (err) {
      set({ error: friendlyError(err, '重命名项目失败') })
    }
  },

  togglePin: (id) => {
    set((state) => {
      const pinned = state.pinned.includes(id) ? state.pinned.filter((item) => item !== id) : [...state.pinned, id]
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(pinned))
      } catch {
        // 存储不可用时只在本次运行内生效。
      }
      return { pinned, projects: sortProjects(state.projects, pinned) }
    })
  },
}))
