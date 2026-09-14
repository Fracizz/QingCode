import { create } from 'zustand'

export type TransferStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
export interface TransferRequest {
  direction: 'upload' | 'download'
  paths: string[]
  destination: string
}
export interface TransferProgress {
  taskId: string
  status: TransferStatus
  completedFiles: number
  completedBytes: number
  completedPaths: string[]
  pendingPaths?: string[]
  currentPath?: string | null
  currentBytes?: number
  currentTotalBytes?: number
  failedPath?: string | null
  error?: string | null
}
export interface TransferTask extends TransferProgress {
  request: TransferRequest
}

export function isTransferActive(status: TransferStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling'
}

export const useTransferStore = create<{
  tasks: TransferTask[]
  add: (task: TransferTask) => void
  update: (taskId: string, progress: Partial<TransferProgress>) => void
  dismiss: (taskId: string) => void
}>(set => ({
  tasks: [],
  add: task => set(state => ({
    tasks: [...state.tasks.filter(item => isTransferActive(item.status)),
      ...state.tasks.filter(item => !isTransferActive(item.status)).slice(-9), task],
  })),
  update: (taskId, progress) => set(state => ({
    tasks: state.tasks.map(task => {
      if (task.taskId !== taskId) return task
      // A completed/cancelled/failed task cannot regress due to a late IPC event.
      if (!isTransferActive(task.status) && progress.status && progress.status !== task.status) return task
      return { ...task, ...progress, taskId: task.taskId }
    }),
  })),
  dismiss: taskId => set(state => ({
    tasks: state.tasks.filter(task => task.taskId !== taskId || isTransferActive(task.status)),
  })),
}))
