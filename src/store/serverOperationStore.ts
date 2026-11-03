import { create } from 'zustand'

export interface ServerOperation {
  rootUri: string
  name: string
  kind: 'install' | 'update'
  step: number
  label: string
  startedAt: number
  finishedAt?: number
  error?: string
}

export const useServerOperationStore = create<{ tasks: Record<string, ServerOperation> }>(() => ({ tasks: {} }))

export function beginServerOperation(rootUri: string, name: string, kind: ServerOperation['kind']) {
  useServerOperationStore.setState(s => ({ tasks: { ...s.tasks, [rootUri]: {
    rootUri, name, kind, step: 1, label: '正在连接 SSH…', startedAt: Date.now(),
  } } }))
}

export function reportServerOperation(rootUri: string, step: number, label: string) {
  useServerOperationStore.setState(s => {
    const task = s.tasks[rootUri]
    return task && !task.finishedAt ? { tasks: { ...s.tasks, [rootUri]: { ...task, step, label } } } : s
  })
}

export function dismissServerOperation(rootUri: string) {
  useServerOperationStore.setState(s => {
    const tasks = { ...s.tasks }
    delete tasks[rootUri]
    return { tasks }
  })
}

export function finishServerOperation(rootUri: string, error?: string) {
  const task = useServerOperationStore.getState().tasks[rootUri]
  if (!task) return
  const finished = { ...task, finishedAt: Date.now(), error }
  useServerOperationStore.setState(s => ({ tasks: { ...s.tasks, [rootUri]: finished } }))
  if (!error) setTimeout(() => {
    if (useServerOperationStore.getState().tasks[rootUri] === finished) dismissServerOperation(rootUri)
  }, 2500)
}
