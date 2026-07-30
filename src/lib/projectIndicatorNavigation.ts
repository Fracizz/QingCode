import type { Project } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'

async function ensureProject(project: Project): Promise<boolean> {
  const current = useProjectStore.getState().currentProject
  if (current?.id === project.id) return true
  return useProjectStore.getState().switchProject(project)
}

export async function navigateToProjectGitChanges(project: Project): Promise<void> {
  const switched = await ensureProject(project)
  if (!switched) return
  useUIStore.getState().setView('sourceControl')
}
