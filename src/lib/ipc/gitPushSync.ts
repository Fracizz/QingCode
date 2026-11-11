/** 「Git 多端同步」的 typed IPC client；模块主体在 src/features/gitPushSync/。 */
import { safeInvoke } from '@/lib/tauri'

/** 只读 HEAD 与上游引用得到的跟踪信息，不扫描工作区。 */
export type PushSyncTracking = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** 给出 `{ remote, branch }` 时只拉这一个分支，否则全量获取。 */
export function fetchForPushSync(
  path: string,
  target?: { remote: string; branch: string },
): Promise<void> {
  return safeInvoke('后台获取远程更新', 'git_push_sync_fetch', {
    path,
    remote: target?.remote ?? null,
    branch: target?.branch ?? null,
  })
}

export function getPushSyncTracking(path: string): Promise<PushSyncTracking> {
  return safeInvoke('读取分支跟踪信息', 'git_push_sync_tracking', { path })
}

export function fastForwardForPushSync(path: string, upstream: string): Promise<void> {
  return safeInvoke('后台快进分支', 'git_push_sync_merge_ff', { path, upstream })
}

export function setPushSyncWatches(paths: string[]): Promise<void> {
  return safeInvoke('同步推送监听', 'git_push_sync_set_watches', { paths })
}
