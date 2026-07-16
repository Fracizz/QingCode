import { create } from 'zustand'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import { useProjectStore } from './projectStore'
import { useTerminalStore, type ShellKind } from './terminalStore'
import { useUIStore } from './uiStore'
import type { Project } from '../types'

export type RunTaskType = 'ps1' | 'bat' | 'sh' | 'command' | 'script'

export interface RunTask {
  id: string
  name?: string
  type: RunTaskType
  target: string
  cwd?: string
  env?: Record<string, string>
}

export interface RunConfig {
  id: string
  name: string
  tasks: RunTask[]
}

interface RunConfigFile {
  configs: RunConfig[]
}

/** `.nestcode/run.json` schema stored at the project root. */
export interface RunConfigFileV1 {
  version: 1
  configs: RunConfig[]
}

function runConfigPath(project: Project): string {
  const sep = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${project.path}${sep}.nestcode${sep}run.json`
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base
  const isAbs = /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')
  if (isAbs) return rel
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}${sep}${rel.replace(/[/\\]+$/, '')}`
}

function normalizeConfigs(input: unknown): RunConfig[] {
  if (!input || typeof input !== 'object') return []
  const file = input as Partial<RunConfigFile>
  const configs = Array.isArray(file.configs) ? file.configs : []
  return configs
    .filter(c => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map(c => ({
      id: c.id,
      name: c.name,
      tasks: Array.isArray(c.tasks) ? c.tasks.map(normalizeTask).filter(Boolean) as RunTask[] : [],
    }))
}

function normalizeTask(t: Partial<RunTask> | undefined): RunTask | null {
  if (!t || typeof t.id !== 'string' || typeof t.target !== 'string') return null
  const allowed: RunTaskType[] = ['ps1', 'bat', 'sh', 'command', 'script']
  const type = allowed.includes(t.type as RunTaskType) ? (t.type as RunTaskType) : 'command'
  return {
    id: t.id,
    name: typeof t.name === 'string' ? t.name : undefined,
    type,
    target: t.target,
    cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
    env: t.env && typeof t.env === 'object' ? (t.env as Record<string, string>) : undefined,
  }
}

function defaultConfigs(): RunConfig[] {
  return [
    {
      id: crypto.randomUUID(),
      name: '前后端',
      tasks: [
        {
          id: crypto.randomUUID(),
          name: '后端',
          type: 'command',
          target: 'python manage.py runserver',
        },
        {
          id: crypto.randomUUID(),
          name: '前端',
          type: 'command',
          target: 'npm run dev',
        },
      ],
    },
  ]
}

interface RunConfigState {
  configsByProject: Record<string, RunConfig[]>
  loadedProjects: Set<string>
  /** task instance key `${configId}:${taskId}` -> terminalId */
  runningByTask: Record<string, string>
  /** configId -> set of task keys currently running */
  runningConfigs: Record<string, string[]>

  loadConfigs: (project: Project) => Promise<RunConfig[]>
  saveConfigs: (project: Project, configs: RunConfig[]) => Promise<void>
  upsertConfig: (project: Project, config: RunConfig) => Promise<void>
  removeConfig: (project: Project, configId: string) => Promise<void>
  runConfig: (project: Project, config: RunConfig) => Promise<void>
  stopConfig: (config: RunConfig) => Promise<void>
  isConfigRunning: (configId: string) => boolean
  taskTerminalId: (configId: string, taskId: string) => string | undefined
  clearStopped: (config: RunConfig) => void
}

export const useRunConfigStore = create<RunConfigState>((set, get) => ({
  configsByProject: {},
  loadedProjects: new Set<string>(),
  runningByTask: {},
  runningConfigs: {},

  loadConfigs: async (project: Project) => {
    if (!isTauri()) {
      set(s => ({ configsByProject: { ...s.configsByProject, [project.id]: [] } }))
      return []
    }
    try {
      const raw = await safeInvoke<string>('读取运行配置', 'read_file', {
        path: runConfigPath(project),
      })
      const parsed = JSON.parse(raw) as RunConfigFile
      const configs = normalizeConfigs(parsed)
      set(s => ({
        configsByProject: { ...s.configsByProject, [project.id]: configs },
        loadedProjects: new Set(s.loadedProjects).add(project.id),
      }))
      return configs
    } catch (e) {
      // File missing or unreadable -> empty configs (not an error for the user).
      set(s => ({
        configsByProject: { ...s.configsByProject, [project.id]: [] },
        loadedProjects: new Set(s.loadedProjects).add(project.id),
      }))
      if (e instanceof NotInTauriError) return []
      return []
    }
  },

  saveConfigs: async (project: Project, configs: RunConfig[]) => {
    try {
      const file: RunConfigFile = { configs }
      const content = JSON.stringify(file, null, 2)
      await safeInvoke('保存运行配置', 'write_file', {
        path: runConfigPath(project),
        content,
      })
      set(s => ({
        configsByProject: { ...s.configsByProject, [project.id]: configs },
      }))
    } catch (e) {
      useProjectStore.getState().pushToast('error', `保存运行配置失败: ${String(e)}`)
      throw e
    }
  },

  upsertConfig: async (project: Project, config: RunConfig) => {
    const current = get().configsByProject[project.id] ?? []
    const idx = current.findIndex(c => c.id === config.id)
    const next = idx >= 0
      ? current.map(c => (c.id === config.id ? config : c))
      : [...current, config]
    await get().saveConfigs(project, next)
  },

  removeConfig: async (project: Project, configId: string) => {
    const current = get().configsByProject[project.id] ?? []
    const target = current.find(c => c.id === configId)
    if (target) await get().stopConfig(target)
    const next = current.filter(c => c.id !== configId)
    await get().saveConfigs(project, next)
  },

  runConfig: async (project: Project, config: RunConfig) => {
    if (!isTauri()) {
      useProjectStore.getState().pushToast('error', new NotInTauriError('运行任务').message)
      return
    }
    const addScriptTerminal = useTerminalStore.getState().addScriptTerminal
    const taskKeys: string[] = []
    for (const task of config.tasks) {
      const cwd = task.cwd ? joinPath(project.path, task.cwd) : project.path
      const name = task.name ? `${config.name} · ${task.name}` : config.name
      const terminalId = await addScriptTerminal(
        project.id,
        cwd,
        task.type as ShellKind,
        task.target,
        task.env ?? {},
        name
      )
      if (terminalId) {
        const key = `${config.id}:${task.id}`
        taskKeys.push(key)
        set(s => ({
          runningByTask: { ...s.runningByTask, [key]: terminalId },
        }))
      }
    }
    set(s => ({ runningConfigs: { ...s.runningConfigs, [config.id]: taskKeys } }))
    useUIStore.getState().openTerminalPanel()
  },

  stopConfig: async (config: RunConfig) => {
    const keys = get().runningConfigs[config.id] ?? []
    const kill = useTerminalStore.getState().closeTerminal
    await Promise.all(
      keys.map(async key => {
        const tid = get().runningByTask[key]
        if (tid) await kill(tid).catch(() => undefined)
      })
    )
    get().clearStopped(config)
  },

  isConfigRunning: (configId: string) => {
    const keys = get().runningConfigs[configId] ?? []
    const byTask = get().runningByTask
    return keys.some(k => byTask[k] && useTerminalStore.getState().terminals.some(t => t.id === byTask[k] && t.status !== 'exited'))
  },

  taskTerminalId: (configId: string, taskId: string) => get().runningByTask[`${configId}:${taskId}`],

  clearStopped: (config: RunConfig) =>
    set(s => {
      const keys = s.runningConfigs[config.id] ?? []
      const runningByTask = { ...s.runningByTask }
      for (const k of keys) delete runningByTask[k]
      const runningConfigs = { ...s.runningConfigs }
      delete runningConfigs[config.id]
      return { runningByTask, runningConfigs }
    }),
}))

export { runConfigPath, defaultConfigs }
