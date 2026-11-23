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
  /** 用户点了“后台运行”：隐藏进度卡，任务继续；失败时自动重新显示。 */
  background?: boolean
  /** 由项目准备流程按后端安装阶段自动创建（而非更新对话框/自动更新），由该流程负责结束。 */
  prepared?: boolean
}

/** 安装/更新的是连接共享的远端服务，卡片标题不用某个项目名；连接名由来源角标显示。 */
export const SHARED_SERVER_OPERATION_NAME = '远端服务'

export const useServerOperationStore = create<{ tasks: Record<string, ServerOperation> }>(() => ({ tasks: {} }))

export function beginServerOperation(
  rootUri: string,
  name: string,
  kind: ServerOperation['kind'],
  progress?: Pick<ServerOperation, 'step' | 'label' | 'startedAt' | 'background'>,
  extra?: Pick<ServerOperation, 'prepared'>,
) {
  useServerOperationStore.setState(s => ({ tasks: { ...s.tasks, [rootUri]: {
    rootUri, name, kind, ...(progress ?? { step: 1, label: '正在连接 SSH…', startedAt: Date.now() }), ...extra,
  } } }))
}

/** 进行中的任务改判类型（如后端随后报告这是替换旧版本：安装 → 更新）。 */
export function setServerOperationKind(rootUri: string, kind: ServerOperation['kind']) {
  useServerOperationStore.setState(s => {
    const task = s.tasks[rootUri]
    return task && !task.finishedAt && task.kind !== kind ? { tasks: { ...s.tasks, [rootUri]: { ...task, kind } } } : s
  })
}

export function reportServerOperation(rootUri: string, step: number, label: string) {
  useServerOperationStore.setState(s => {
    const task = s.tasks[rootUri]
    return task && !task.finishedAt ? { tasks: { ...s.tasks, [rootUri]: { ...task, step, label } } } : s
  })
}

/** 切到后台运行 / 重新展开进度卡，不影响任务本身；不能用 dismiss，否则后续进度和错误会丢失。 */
export function setServerOperationBackground(rootUri: string, background: boolean) {
  useServerOperationStore.setState(s => {
    const task = s.tasks[rootUri]
    return task && Boolean(task.background) !== background ? { tasks: { ...s.tasks, [rootUri]: { ...task, background } } } : s
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
  const finished = { ...task, finishedAt: Date.now(), error, background: error ? false : task.background }
  useServerOperationStore.setState(s => ({ tasks: { ...s.tasks, [rootUri]: finished } }))
  if (!error) setTimeout(() => {
    if (useServerOperationStore.getState().tasks[rootUri] === finished) dismissServerOperation(rootUri)
  }, 2500)
}

function connectionOf(path: string): string | undefined {
  return path.match(/^ssh:\/\/([^/]+)/)?.[1] || undefined
}

/** 同一 SSH 连接上其他项目正在进行的安装/更新任务：服务按连接共享，不再另开一张卡。 */
export function activeServerOperationOnConnection(
  tasks: Record<string, ServerOperation>,
  rootUri: string,
): ServerOperation | undefined {
  const connection = connectionOf(rootUri)
  if (!connection) return undefined
  return Object.values(tasks).find(task => task.rootUri !== rootUri && !task.finishedAt && connectionOf(task.rootUri) === connection)
}

/**
 * 项目对应的服务任务：优先本项目，其次同一 SSH 连接上的任务。服务按连接共享，
 * 同连接其他项目打开时显示的是同一个安装/更新进度。
 */
export function serverOperationForProject(
  tasks: Record<string, ServerOperation>,
  project: { path: string; connection_id?: string | null },
): ServerOperation | undefined {
  const exact = tasks[project.path]
  if (exact) return exact
  const connection = project.connection_id || connectionOf(project.path)
  if (!connection) return undefined
  return Object.values(tasks).find(task => !task.finishedAt && connectionOf(task.rootUri) === connection)
}
