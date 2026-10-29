import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useProjectStore } from '../store/projectStore'
import { startSshWarmupQueue, stopSshWarmupQueue, useSshWarmupStore } from '../store/sshWarmupStore'
import { selectWarmupTargets, type SshWarmupQueue } from '../lib/sshWarmupQueue'
import type { FileNode } from '../lib/fileTreeCache'
import { createProjectTrustChecker, WORKSPACE_TRUST_CHANGED_EVENT } from '../lib/workspaceTrust'
import { isSshBackgroundSuspended, SSH_CONNECTION_INVALIDATED_EVENT } from '../lib/sshWorkspace'
import { hasBackend } from '../lib/runtimeCapabilities'
import { shouldRestoreWorkspace } from '../lib/windowSession'

/** Window-lifetime coordinator: one bounded queue and one timer, independent of
 * title-bar layout/overflow measurement and of Git badge polling. */
export function useSshWarmup(ready: boolean) {
  const projects = useProjectStore(state => state.projects)
  const connections = useProjectStore(state => state.sshConnections)
  const currentId = useProjectStore(state => state.currentProject?.id)
  const queueRef = useRef<SshWarmupQueue<FileNode[] | null> | null>(null)

  useEffect(() => {
    if (!ready || !hasBackend() || !shouldRestoreWorkspace()) return
    const queue = startSshWarmupQueue()
    queueRef.current = queue
    const refresh = () => {
      const state = useProjectStore.getState()
      const trusted = createProjectTrustChecker()
      queue.update(
        selectWarmupTargets(
          state.projects,
          state.sshConnections,
          project =>
            trusted(project) &&
            !isSshBackgroundSuspended(project.connection_id || project.path.split('/')[2])
        ),
        state.currentProject?.path
      )
    }
    const visibility = () => queue.setPaused(document.hidden)
    const invalidate = (event: Event) =>
      queue.invalidateConnection((event as CustomEvent<string>).detail)
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === 'qingcode:workspace-trust') refresh()
    }
    let disposed = false
    const unlisten = listen<{ rootUri: string; connectionId: string; phase: string }>(
      'ssh-server-state',
      event => {
        if (disposed || event.payload.phase !== 'disconnected') return
        // An initial authentication failure must remain visible as a failed
        // preparation; only invalidate previously ready cached roots here.
        if (useSshWarmupStore.getState().statuses.get(event.payload.rootUri)?.phase === 'ready') {
          queue.invalidateConnection(event.payload.connectionId)
        }
      }
    ).catch(() => () => {})
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, refresh)
    window.addEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
    window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', visibility)
    visibility()
    refresh()
    return () => {
      disposed = true
      void unlisten.then(stop => stop())
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, refresh)
      window.removeEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
      window.removeEventListener('storage', storage)
      document.removeEventListener('visibilitychange', visibility)
      queueRef.current = null
      stopSshWarmupQueue(queue)
    }
  }, [ready])

  useEffect(() => {
    const trusted = createProjectTrustChecker()
    queueRef.current?.update(
      selectWarmupTargets(
        projects,
        connections,
        project =>
          trusted(project) &&
          !isSshBackgroundSuspended(project.connection_id || project.path.split('/')[2])
      ),
      projects.find(project => project.id === currentId)?.path
    )
  }, [projects, connections, currentId])
}
