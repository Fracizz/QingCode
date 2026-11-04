import { create } from 'zustand'
import type { FavoriteItem, Project } from '../types'
import {
  favoriteAbsolutePath,
  favoriteRelativePath,
  favoriteRelativePathKey,
  moveFavoritePath as moveFavoritePathList,
  removeFavoritePath as removeFavoritePathList,
  reorderFavoriteItems,
} from '../lib/favoriteItems'
import {
  insertFavoriteItem,
  loadFavoriteItems,
  replaceFavoriteItems,
} from '../lib/favoriteRepository'
import { safeInvoke } from '../lib/tauri'

type FavoriteDropPosition = 'before' | 'after'

interface FavoriteState {
  itemsByProject: Record<string, FavoriteItem[]>
  loadedProjectIds: string[]
  loadingProjectIds: string[]
  loadProjectFavorites: (project: Project, options?: { force?: boolean }) => Promise<void>
  addFavorite: (project: Project, absolutePath: string, kind: FavoriteItem['kind']) => Promise<boolean>
  removeFavorite: (project: Project, relativePath: string) => Promise<void>
  reorderFavorite: (
    project: Project,
    sourcePath: string,
    targetPath: string,
    position: FavoriteDropPosition,
  ) => Promise<void>
  moveFavoritePath: (project: Project, oldPath: string, newPath: string) => Promise<void>
  removeFavoritePath: (project: Project, absolutePath: string) => Promise<void>
}

async function probeAvailability(project: Project, items: FavoriteItem[]): Promise<FavoriteItem[]> {
  return Promise.all(
    items.map(async item => {
      try {
        const stat = await safeInvoke<{ is_dir: boolean }>('检查收藏项', 'file_stat', {
          path: favoriteAbsolutePath(project.path, item.relativePath),
        })
        return {
          ...item,
          kind: stat.is_dir ? 'directory' : 'file',
          available: true,
        }
      } catch {
        return { ...item, available: false }
      }
    }),
  )
}

function includesId(ids: string[], id: string): boolean {
  return ids.includes(id)
}

const favoriteLoads = new Map<string, Promise<void>>()

export const useFavoriteStore = create<FavoriteState>((set, get) => ({
  itemsByProject: {},
  loadedProjectIds: [],
  loadingProjectIds: [],

  loadProjectFavorites: async (project, options) => {
    if (!options?.force && includesId(get().loadedProjectIds, project.id)) return
    const inFlight = favoriteLoads.get(project.id)
    if (inFlight) return inFlight
    const task = (async () => {
      set(state => ({ loadingProjectIds: [...state.loadingProjectIds, project.id] }))
      try {
        const loaded = project.ephemeral ? [] : await loadFavoriteItems(project.id)
        const items = await probeAvailability(project, loaded)
        set(state => ({
          itemsByProject: { ...state.itemsByProject, [project.id]: items },
          loadedProjectIds: includesId(state.loadedProjectIds, project.id)
            ? state.loadedProjectIds
            : [...state.loadedProjectIds, project.id],
        }))
      } finally {
        set(state => ({
          loadingProjectIds: state.loadingProjectIds.filter(id => id !== project.id),
        }))
      }
    })()
    favoriteLoads.set(project.id, task)
    try {
      await task
    } finally {
      favoriteLoads.delete(project.id)
    }
  },

  addFavorite: async (project, absolutePath, kind) => {
    const relativePath = favoriteRelativePath(project.path, absolutePath)
    if (!relativePath) return false
    await get().loadProjectFavorites(project)
    const existing = get().itemsByProject[project.id] ?? []
    const key = favoriteRelativePathKey(project.path, relativePath)
    if (existing.some(item => favoriteRelativePathKey(project.path, item.relativePath) === key)) {
      return false
    }
    const item: FavoriteItem = {
      projectId: project.id,
      relativePath,
      kind,
      sortOrder: existing.length,
      createdAt: Date.now(),
      available: true,
    }
    if (!project.ephemeral) await insertFavoriteItem(item)
    set(state => ({
      itemsByProject: {
        ...state.itemsByProject,
        [project.id]: [...(state.itemsByProject[project.id] ?? []), item],
      },
    }))
    return true
  },

  removeFavorite: async (project, relativePath) => {
    await get().loadProjectFavorites(project)
    const next = (get().itemsByProject[project.id] ?? [])
      .filter(item => item.relativePath !== relativePath)
      .map((item, index) => ({ ...item, sortOrder: index }))
    if (!project.ephemeral) await replaceFavoriteItems(project.id, next)
    set(state => ({
      itemsByProject: { ...state.itemsByProject, [project.id]: next },
    }))
  },

  reorderFavorite: async (project, sourcePath, targetPath, position) => {
    await get().loadProjectFavorites(project)
    const current = get().itemsByProject[project.id] ?? []
    const next = reorderFavoriteItems(current, sourcePath, targetPath, position)
    if (next === current) return
    if (!project.ephemeral) await replaceFavoriteItems(project.id, next)
    set(state => ({
      itemsByProject: { ...state.itemsByProject, [project.id]: next },
    }))
  },

  moveFavoritePath: async (project, oldPath, newPath) => {
    await get().loadProjectFavorites(project)
    const current = get().itemsByProject[project.id] ?? []
    const next = moveFavoritePathList(current, project.path, oldPath, newPath)
    if (next === current || next.every((item, index) => item === current[index])) return
    if (!project.ephemeral) await replaceFavoriteItems(project.id, next)
    set(state => ({
      itemsByProject: { ...state.itemsByProject, [project.id]: next },
    }))
  },

  removeFavoritePath: async (project, absolutePath) => {
    await get().loadProjectFavorites(project)
    const current = get().itemsByProject[project.id] ?? []
    const next = removeFavoritePathList(current, project.path, absolutePath)
    if (next.length === current.length) return
    if (!project.ephemeral) await replaceFavoriteItems(project.id, next)
    set(state => ({
      itemsByProject: { ...state.itemsByProject, [project.id]: next },
    }))
  },
}))
