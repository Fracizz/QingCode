import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { safeInvoke } from './tauri'
import { useTransferStore, isTransferActive, type TransferProgress, type TransferRequest } from '../store/transferStore'
import { useProjectStore } from '../store/projectStore'
import { findProjectForPath } from '../utils/fileReferences'

/** Subscribe before starting so even a tiny transfer has a complete lifecycle. */
export async function startSshTransfer(request: TransferRequest): Promise<TransferProgress> {
  const taskId = crypto.randomUUID()
  const store = useTransferStore.getState()
  const initial: TransferProgress = {
    taskId, status: 'queued', completedFiles: 0, completedBytes: 0,
    completedPaths: [], pendingPaths: request.paths,
  }
  store.add({ ...initial, request })
  let unlisten: UnlistenFn | undefined
  let result: TransferProgress
  try {
    unlisten = await listen<TransferProgress>('ssh-transfer-progress', event => {
      const current = useTransferStore.getState().tasks.find(task => task.taskId === taskId)
      if (event.payload.taskId !== taskId || !current || !isTransferActive(current.status)) return
      store.update(taskId, {
        ...event.payload,
        status: current.status === 'cancelling' && event.payload.status === 'running'
          ? 'cancelling' : event.payload.status,
      })
    })
    if (useTransferStore.getState().tasks.find(task => task.taskId === taskId)?.status === 'cancelling') {
      result = { ...initial, status: 'cancelled' }
    } else {
      store.update(taskId, { status: 'running' })
      result = await safeInvoke<TransferProgress>('传输文件', 'ssh_transfer_paths', { taskId, ...request })
    }
  } catch (error) {
    const current = useTransferStore.getState().tasks.find(task => task.taskId === taskId)
    result = current && !isTransferActive(current.status)
      ? current
      : { ...initial, ...current, taskId, status: 'failed', error: String(error) }
  } finally {
    unlisten?.()
  }
  const terminal = useTransferStore.getState().tasks.find(task => task.taskId === taskId)
  if (terminal && !isTransferActive(terminal.status)) result = terminal
  store.update(taskId, result)
  if (request.direction === 'upload') {
    const projects = useProjectStore.getState()
    const project = findProjectForPath(projects.projects, request.destination)
    if (project) void projects.refreshProjectTree(project)
  }
  return result
}

export async function cancelSshTransfer(taskId: string): Promise<void> {
  const store = useTransferStore.getState()
  const task = store.tasks.find(item => item.taskId === taskId)
  if (!task || !isTransferActive(task.status) || task.status === 'cancelling') return
  store.update(taskId, { status: 'cancelling' })
  if (task.status === 'queued') return
  try {
    await safeInvoke('取消传输', 'cancel_ssh_transfer', { taskId })
  } catch (error) {
    const current = useTransferStore.getState().tasks.find(item => item.taskId === taskId)
    if (current && isTransferActive(current.status)) {
      store.update(taskId, { status: 'running', error: String(error) })
    }
  }
}

export function retrySshTransfer(taskId: string): Promise<TransferProgress> | undefined {
  const store = useTransferStore.getState()
  const task = store.tasks.find(item => item.taskId === taskId)
  if (!task || isTransferActive(task.status) || task.status === 'completed') return
  const paths = (task.pendingPaths ?? task.request.paths).filter(path => !task.completedPaths.includes(path))
  if (paths.length === 0) return
  store.dismiss(taskId)
  return startSshTransfer({ ...task.request, paths })
}
