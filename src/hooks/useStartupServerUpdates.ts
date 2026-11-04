import { useEffect } from 'react'
import type { Project, SshConnection } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { createProjectTrustChecker, isProjectTrusted } from '../lib/workspaceTrust'
import { hasBackend } from '../lib/runtimeCapabilities'
import { shouldRestoreWorkspace } from '../lib/windowSession'
import { translate } from '../lib/i18n'
import {
  ensureSshWorkspaceConnected,
  isSshBackgroundSuspended,
  prepareSshWorkspace,
  sshConnectionIdFromUri,
  SSH_SERVER_UPDATED_EVENT,
} from '../lib/sshWorkspace'

/** One representative trusted root per saved direct Server, including hidden projects. */
export function startupServerTargets(
  projects: readonly Project[],
  connections: readonly SshConnection[],
  trusted: (project: Project) => boolean,
): Project[] {
  const directIds = new Set(connections.filter(connection => connection.agentEndpoint).map(connection => connection.id))
  const selected = new Map<string, Project>()
  for (const project of projects) {
    const id = sshConnectionIdFromUri(project.path)
    if (!id || !directIds.has(id) || !trusted(project)) continue
    const previous = selected.get(id)
    if (!previous || project.last_opened_at > previous.last_opened_at) selected.set(id, project)
  }
  return [...selected.values()].sort((a, b) => b.last_opened_at - a.last_opened_at)
}

export function useStartupServerUpdates(ready: boolean) {
  // Listen before project restoration starts; the restored project can update
  // while loadProjects is still pending, before the startup scan is released.
  useEffect(() => {
    if (!hasBackend()) return
    const completed = (event: Event) => {
      const { rootUri, name } = (event as CustomEvent<{ rootUri: string; name: string }>).detail
      useProjectStore.getState().pushToast('success', translate('已自动更新 {name} 的远端服务', { name }))
      if (useUIStore.getState().serverUpdateRootUri === rootUri) {
        useUIStore.setState({ serverUpdateRootUri: null })
      }
    }
    window.addEventListener(SSH_SERVER_UPDATED_EVENT, completed)
    return () => window.removeEventListener(SSH_SERVER_UPDATED_EVENT, completed)
  }, [])

  useEffect(() => {
    if (!ready || !hasBackend() || !shouldRestoreWorkspace()) return
    const controller = new AbortController()
    const { signal } = controller
    // StrictMode's initial effect cleanup cancels this scan before any IPC.
    queueMicrotask(() => {
      if (signal.aborted) return
      const state = useProjectStore.getState()
      const targets = startupServerTargets(state.projects, state.sshConnections, createProjectTrustChecker())
      void (async () => {
        // Sequential per connection: no startup burst and no duplicate roots.
        for (const project of targets) {
          if (signal.aborted) return
          const id = sshConnectionIdFromUri(project.path)!
          if (!isProjectTrusted(project) || isSshBackgroundSuspended(id)) continue
          try {
            await ensureSshWorkspaceConnected(project, { background: true, signal })
            signal.throwIfAborted()
            if (!isProjectTrusted(project) || isSshBackgroundSuspended(id)) continue
            await prepareSshWorkspace(project.path, signal, () => {}, { project, background: true })
          } catch {
            // Failed updates retain the shared progress card and manual recovery.
            // Unreachable hosts must not open authentication or update dialogs.
          }
        }
      })()
    })
    return () => controller.abort()
  }, [ready])
}
