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

/** 同时检查/更新的远端数量上限，避免保存了大量连接时启动瞬间并发过多 SSH 与上传。 */
export const STARTUP_SERVER_UPDATE_CONCURRENCY = 4

/**
 * 按远端网关分组：不同网关并发，指向同一 endpoint 的连接留在同一组内串行。
 * 后端更新锁按连接 id 隔离，挡不住两条连接同时重启同一个网关。
 */
export function startupServerLanes(
  targets: readonly Project[],
  connections: readonly SshConnection[],
): Project[][] {
  const byId = new Map(connections.map(connection => [connection.id, connection]))
  const lanes = new Map<string, Project[]>()
  for (const project of targets) {
    const id = sshConnectionIdFromUri(project.path)!
    const endpoint = byId.get(id)?.agentEndpoint
    const key = endpoint ? `${endpoint.host.trim().toLowerCase()}:${endpoint.port}` : id
    lanes.set(key, [...(lanes.get(key) ?? []), project])
  }
  return [...lanes.values()]
}

async function checkStartupServer(project: Project, signal: AbortSignal) {
  const id = sshConnectionIdFromUri(project.path)!
  if (!isProjectTrusted(project) || isSshBackgroundSuspended(id)) return
  try {
    await ensureSshWorkspaceConnected(project, { background: true, signal })
    signal.throwIfAborted()
    if (!isProjectTrusted(project) || isSshBackgroundSuspended(id)) return
    await prepareSshWorkspace(project.path, signal, () => {}, { project, background: true })
  } catch {
    // Failed updates retain the shared progress card and manual recovery.
    // Unreachable hosts must not open authentication or update dialogs.
  }
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
      const lanes = startupServerLanes(targets, state.sshConnections)
      let next = 0
      // 各远端互不等待：不可达或上传慢的主机只占一个并发名额。
      const worker = async () => {
        while (next < lanes.length && !signal.aborted) {
          for (const project of lanes[next++]) {
            if (signal.aborted) return
            await checkStartupServer(project, signal)
          }
        }
      }
      for (let i = 0; i < Math.min(STARTUP_SERVER_UPDATE_CONCURRENCY, lanes.length); i++) void worker()
    })
    return () => controller.abort()
  }, [ready])
}
