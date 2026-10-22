import { isTransferActive, type TransferTask } from '../store/transferStore'
import { baseName } from './fileTreeHelpers'

/** Drop the `ssh://<connection-id>` prefix so transfer rows stay short. */
export function formatTransferLocation(path: string): string {
  const value = path.trim()
  if (!value.startsWith('ssh://')) return value
  return value.replace(/^ssh:\/\/[^/]+/, '') || '/'
}

/** File name while running; source names once the remote destination is no longer useful. */
export function transferTaskDetail(
  task: Pick<TransferTask, 'status' | 'currentPath' | 'request'>,
): string {
  if (isTransferActive(task.status) && task.currentPath?.trim()) {
    return baseName(task.currentPath) || formatTransferLocation(task.currentPath)
  }
  const names = task.request.paths.map(path => baseName(path)).filter(Boolean)
  if (names.length > 0) return names.join('、')
  return formatTransferLocation(task.request.destination)
}
