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

interface ConnectionHold {
  connectionId: string
  release?: (verified: boolean) => void
}
/** 进行中的连接级服务检查/更新，同样跨队列重建保留。 */
const connectionHolds = new Set<ConnectionHold>()

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
  for (const hold of connectionHolds) hold.release = next.holdConnection(hold.connectionId)
  return next
}

export function stopSshWarmupQueue(expected: SshWarmupQueue<FileNode[] | null>) {
  if (queue !== expected) return
  expected.dispose()
  queue = undefined
}

/** 暂停同一连接的后台准备；省略连接时暂停全部。本机项目不申请租约。 */
export function beginSshForeground(connectionId?: string): () => void {
  const lease: ForegroundLease = { connectionId, release: queue?.beginForeground(connectionId) }
  foregroundLeases.add(lease)
  return () => {
    if (!foregroundLeases.delete(lease)) return
    lease.release?.()
  }
}

/**
 * 连接级服务检查/自动更新期间暂停该连接的后台项目准备；结束时传入服务是否已确认可用，
 * 可用则同连接项目立即并发准备。
 */
export function holdSshWarmupConnection(connectionId: string): (verified: boolean) => void {
  const hold: ConnectionHold = { connectionId, release: queue?.holdConnection(connectionId) }
  connectionHolds.add(hold)
  return verified => {
    if (!connectionHolds.delete(hold)) return
    if (hold.release) hold.release(verified)
    else if (verified) queue?.connectionVerified(connectionId)
  }
}

/** 连接的远端服务已确认可用（如手动更新完成）：同连接项目立即重新准备。 */
export function markSshWarmupConnectionVerified(connectionId: string) {
  queue?.connectionVerified(connectionId)
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
