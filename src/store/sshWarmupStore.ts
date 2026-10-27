import { create } from 'zustand'
import { loadWarmupRootTree, type FileNode } from '../lib/fileTreeCache'
import { isProjectTrusted } from '../lib/workspaceTrust'
import {
  ensureSshWorkspaceConnected,
  isSshBackgroundSuspended,
  prepareSshWorkspace,
} from '../lib/sshWorkspace'
import { SshWarmupQueue, type WarmupStatus } from '../lib/sshWarmupQueue'

export const useSshWarmupStore = create<{ statuses: ReadonlyMap<string, WarmupStatus> }>(() => ({
  statuses: new Map(),
}))
let queue: SshWarmupQueue<FileNode[] | null> | undefined

export function startSshWarmupQueue(): SshWarmupQueue<FileNode[] | null> {
  queue?.dispose()
  const next = new SshWarmupQueue<FileNode[] | null>({
    run: async ({ project, connectionId }, signal) => {
      const check = () => {
        signal.throwIfAborted()
        if (!isProjectTrusted(project)) throw new Error('项目未受信任')
        if (isSshBackgroundSuspended(connectionId)) throw new Error('SSH 连接已主动断开')
      }
      check()
      await ensureSshWorkspaceConnected(project, { background: true, signal })
      check()
      // No periodic status poll for passive preparation. The native operation
      // already emits progress; polling would multiply work for large lists.
      await prepareSshWorkspace(project.path, signal, () => {}, { project, background: true })
      check()
      const tree = await loadWarmupRootTree(project)
      check()
      return tree
    },
    weight: tree => tree?.length ?? 0,
    changed: statuses => useSshWarmupStore.setState({ statuses }),
  })
  queue = next
  return next
}

export function stopSshWarmupQueue(expected: SshWarmupQueue<FileNode[] | null>) {
  if (queue !== expected) return
  expected.dispose()
  queue = undefined
}

export function beginSshForeground(): () => void {
  return queue?.beginForeground() ?? (() => {})
}

export function takeSshWarmup(path: string): Promise<FileNode[] | null> | undefined {
  return queue?.take(path)
}

export function cancelSshWarmup(path: string) {
  queue?.invalidateRoot(path)
}
