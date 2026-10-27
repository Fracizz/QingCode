import type { RunTask, RunTaskType } from '../store/runConfigStore'

export type RunOs = 'windows' | 'linux' | 'macos'
export type RunTaskOverride = Partial<Pick<RunTask, 'type' | 'target' | 'cwd' | 'env'>>
export type RunTaskOs = Partial<Record<RunOs, RunTaskOverride>>
export const RUN_OS: RunOs[] = ['windows', 'linux', 'macos']
const TASK_TYPES: RunTaskType[] = ['command', 'ps1', 'bat', 'sh', 'script']

export function parseRunTaskOs(value: unknown): RunTaskOs | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('task.os must be an object (windows, linux, macos)')
  }
  const result: RunTaskOs = {}
  for (const [os, fields] of Object.entries(value)) {
    if (!RUN_OS.includes(os as RunOs)) throw new Error(`Unsupported task.os: ${os}`)
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error(`task.os.${os} must be an object`)
    }
    const override: RunTaskOverride = {}
    for (const [key, field] of Object.entries(fields)) {
      if (key === 'env') {
        if (
          !field ||
          typeof field !== 'object' ||
          Array.isArray(field) ||
          Object.values(field).some(v => typeof v !== 'string')
        ) {
          throw new Error(`task.os.${os}.env must contain string values`)
        }
        override.env = { ...field } as Record<string, string>
      } else if (key === 'type') {
        if (!TASK_TYPES.includes(field as RunTaskType))
          throw new Error(`Invalid task.os.${os}.type`)
        override.type = field as RunTaskType
      } else if (key === 'target' || key === 'cwd') {
        if (typeof field !== 'string') throw new Error(`task.os.${os}.${key} must be a string`)
        override[key] = field.trim()
      } else {
        throw new Error(`Unsupported task.os.${os} field: ${key}`)
      }
    }
    result[os as RunOs] = override
  }
  return result
}

export function hasRunTaskTarget(task: Pick<RunTask, 'target' | 'os'>): boolean {
  return !!task.target.trim() || Object.values(task.os ?? {}).some(o => !!o.target?.trim())
}

export function resolveRunTask(task: RunTask, os: RunOs): RunTask {
  const override = task.os?.[os]
  const resolved = {
    ...task,
    ...override,
    env: task.env || override?.env ? { ...task.env, ...override?.env } : undefined,
  }
  if (!resolved.target.trim())
    throw new Error(`任务「${task.name ?? task.id}」未配置 ${os} 的 target`)
  if (os !== 'windows' && resolved.type === 'bat') {
    throw new Error(`任务「${task.name ?? task.id}」的 BAT 类型不适用于 ${os}`)
  }
  return resolved
}
