/** 「Git 多端同步」的 typed IPC client；模块主体在 src/features/gitPushSync/。 */
import { safeInvoke } from '@/lib/tauri'

export function fetchForPushSync(path: string): Promise<void> {
  return safeInvoke('后台获取远程更新', 'git_push_sync_fetch', { path })
}

export function fastForwardForPushSync(path: string, upstream: string): Promise<void> {
  return safeInvoke('后台快进分支', 'git_push_sync_merge_ff', { path, upstream })
}

export function setPushSyncWatches(paths: string[]): Promise<void> {
  return safeInvoke('同步推送监听', 'git_push_sync_set_watches', { paths })
}
