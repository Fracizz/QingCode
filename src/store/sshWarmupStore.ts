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

interface ForegroundLease {
  connectionId?: string
  release?: () => void
}
/** 进行中的前台打开，跨队列重建保留，避免队列晚于打开流程创建时漏掉让路。 */
const foregroundLeases = new Set<ForegroundLease>()

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
  // 队列创建前已开始的前台打开（如启动恢复的项目）仍要让同连接的后台任务让路。
  for (const lease of foregroundLeases) lease.release = next.beginForeground(lease.connectionId)
  return next
}

export function stopSshWarmupQueue(expected: SshWarmupQueue<FileNode[] | null>) {
  if (queue !== expected) return
  expected.dispose()
  queue = undefined
}

/** 只暂停该连接的后台预热；不传（本机项目）则暂停全部。 */
export function beginSshForeground(connectionId?: string): () => void {
  const lease: ForegroundLease = { connectionId, release: queue?.beginForeground(connectionId) }
  foregroundLeases.add(lease)
  return () => {
    if (!foregroundLeases.delete(lease)) return
    lease.release?.()
  }
}

export function takeSshWarmup(path: string): Promise<FileNode[] | null | undefined> | undefined {
  return queue?.take(path)
}

/** 取走之前的状态，用于记录这次打开为什么没命中预热。 */
export function peekSshWarmup(path: string): WarmupStatus | undefined {
  return useSshWarmupStore.getState().statuses.get(path)
}

export function cancelSshWarmup(path: string) {
  queue?.invalidateRoot(path)
}
