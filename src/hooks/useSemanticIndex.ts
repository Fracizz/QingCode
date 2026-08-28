import { useEffect, useRef } from 'react'
import {
  clearSemanticOverlay,
  prepareSemanticIndex,
  syncDirtySemanticOverlay,
} from '../lib/semanticNavigation'
import { isTauri } from '../lib/tauri'
import { isSshResource } from '../lib/tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import type { EditorTab } from '../types'

const preparingRoots = new Set<string>()
const preparedRoots = new Set<string>()

function key(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}
function allTabs(
  tabs: EditorTab[],
  projectSessions: Record<string, { tabs: EditorTab[] }>
): EditorTab[] {
  return [...tabs, ...Object.values(projectSessions).flatMap(session => session.tabs)]
}

export function useSemanticIndex() {
  const currentProject = useProjectStore(state => state.currentProject)
  const projects = useProjectStore(state => state.projects)
  const tabs = useEditorStore(state => state.tabs)
  const projectSessions = useEditorStore(state => state.projectSessions)
  const previousDirtyPaths = useRef(new Map<string, string>())

  useEffect(() => {
    if (!isTauri()) return
    const roots = new Set<string>()
    if (currentProject && !currentProject.ephemeral && !isSshResource(currentProject.path)) {
      roots.add(currentProject.path)
    }
    for (const [projectId, session] of Object.entries(projectSessions)) {
      if (session.tabs.length === 0) continue
      const project = projects.find(candidate => candidate.id === projectId)
      if (project && !project.ephemeral && !isSshResource(project.path)) roots.add(project.path)
    }
    for (const root of roots) {
      const rootKey = key(root)
      if (preparingRoots.has(rootKey) || preparedRoots.has(rootKey)) continue
      preparingRoots.add(rootKey)
      void prepareSemanticIndex(root)
        .then(status => {
          if (status?.complete) preparedRoots.add(rootKey)
        })
        .catch(error => {
          console.error('semantic index preparation failed:', error)
        })
        .finally(() => {
          preparingRoots.delete(rootKey)
        })
    }
  }, [currentProject, projectSessions, projects])

  useEffect(() => {
    if (!isTauri()) return
    const dirtyPaths = new Map<string, string>()
    for (const tab of allTabs(tabs, projectSessions)) {
      if (
        tab.kind === 'diff' ||
        !tab.dirty ||
        tab.loading ||
        tab.openError ||
        isSshResource(tab.path)
      )
        continue
      dirtyPaths.set(key(tab.path), tab.path)
      if (!previousDirtyPaths.current.has(key(tab.path))) {
        void syncDirtySemanticOverlay(tab.path).catch(error => {
          console.error('initial semantic overlay sync failed:', error)
        })
      }
    }
    for (const [pathKey, path] of previousDirtyPaths.current) {
      if (dirtyPaths.has(pathKey)) continue
      void clearSemanticOverlay(path).catch(error => {
        console.error('semantic overlay clear failed:', error)
      })
    }
    previousDirtyPaths.current = dirtyPaths
  }, [projectSessions, tabs])
}
