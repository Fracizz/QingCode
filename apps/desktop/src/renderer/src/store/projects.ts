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
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  targetId: null,
  selectedId: null,
  loading: false,
  error: null,

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
        projects: [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
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
        projects: state.projects
          .map((item) => (item.id === saved.id ? saved : item))
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
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
}))
