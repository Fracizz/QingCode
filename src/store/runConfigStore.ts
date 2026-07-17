import { create } from 'zustand'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import { translate } from '../lib/i18n'
import { isProjectTrusted, trustProject } from '../lib/runTrust'
import { confirmDialog } from './confirmStore'
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

/** `.qingcode/run.json` schema stored at the project root. */
export interface RunConfigFileV1 {
  version: 1
  configs: RunConfig[]
}

function projectConfigDir(project: Project): string {
  const sep = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${project.path}${sep}.qingcode`
}

function legacyRunConfigPath(project: Project): string {
  const sep = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${project.path}${sep}.nestcode${sep}run.json`
}

function runConfigPath(project: Project): string {
  const sep = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${projectConfigDir(project)}${sep}run.json`
}

/** Display path for UI — always forward slashes, relative to project root. */
export const RUN_CONFIG_RELATIVE_PATH = '.qingcode/run.json'

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
  const cwd = typeof t.cwd === 'string' ? t.cwd.trim() || undefined : undefined
  let target = t.target.trim()
  if (type === 'command' && cwd) {
    target = stripRedundantCdPrefix(target)
  }
  return {
    id: t.id,
    name: typeof t.name === 'string' ? t.name : undefined,
    type,
    target,
    cwd,
    env: t.env && typeof t.env === 'object' ? (t.env as Record<string, string>) : undefined,
  }
}

/** When cwd is set, leading `cd …;` / `cd … &&` in target is redundant and often breaks on Windows CMD. */
function stripRedundantCdPrefix(target: string): string {
  return target.replace(/^(?:cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:;|&&|&)\s*)+/i, '').trim()
}

const TASK_TYPE_LABEL: Record<RunTaskType, string> = {
  ps1: 'ps1',
  bat: 'bat',
  sh: 'sh',
  command: '命令',
  script: '脚本',
}

function formatEnv(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return translate('（无）')
  return Object.entries(env)
    .map(([key, value]) => `  ${key}=${value}`)
    .join('\n')
}

/** Human-readable summary shown in the first-run trust confirmation. */
function formatRunTrustDetail(project: Project, config: RunConfig): string {
  const lines: string[] = [
    translate('来源：项目配置 {path}', { path: RUN_CONFIG_RELATIVE_PATH }),
    translate('项目：{name}', { name: project.name }),
    translate('配置：{name}', { name: config.name }),
    '',
  ]
  config.tasks.forEach((task, index) => {
    const cwd = task.cwd ? joinPath(project.path, task.cwd) : project.path
    const taskTitle = task.name
      ? translate('任务 {index} · {name}', { index: index + 1, name: task.name })
      : translate('任务 {index}', { index: index + 1 })
    lines.push(taskTitle)
    lines.push(translate('  类型：{type}', { type: translate(TASK_TYPE_LABEL[task.type]) }))
    lines.push(translate('  命令 / 脚本：{target}', { target: task.target || translate('（空）') }))
    lines.push(translate('  工作目录：{cwd}', { cwd }))
    lines.push(translate('  环境变量：'))
    lines.push(formatEnv(task.env))
    if (index < config.tasks.length - 1) lines.push('')
  })
  return lines.join('\n')
}

async function ensureRunTrust(project: Project, config: RunConfig): Promise<boolean> {
  if (isProjectTrusted(project)) return true
  const choice = await confirmDialog({
    title: translate('运行项目任务'),
    message: translate(
      '即将执行来自项目配置（{path}）的命令。未信任的仓库可能包含恶意脚本，请确认后再运行。',
      { path: RUN_CONFIG_RELATIVE_PATH },
    ),
    detail: formatRunTrustDetail(project, config),
    kind: 'warning',
    confirmLabel: translate('确认一次'),
    altLabel: translate('信任此项目'),
    cancelLabel: translate('取消'),
  })
  if (choice === false) return false
  if (choice === 'alt') trustProject(project)
  return true
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
          target: '',
        },
        {
          id: crypto.randomUUID(),
          name: '前端',
          type: 'command',
          target: '',
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
    const readConfigs = async (path: string) => {
      const raw = await safeInvoke<string>('读取运行配置', 'read_file', { path })
      return normalizeConfigs(JSON.parse(raw) as RunConfigFile)
    }
    try {
      const configs = await readConfigs(runConfigPath(project))
      set(s => ({
        configsByProject: { ...s.configsByProject, [project.id]: configs },
        loadedProjects: new Set(s.loadedProjects).add(project.id),
      }))
      return configs
    } catch {
      try {
        const legacyPath = legacyRunConfigPath(project)
        const configs = await readConfigs(legacyPath)
        await safeInvoke('保存运行配置', 'write_file', {
          path: runConfigPath(project),
          content: JSON.stringify({ configs } satisfies RunConfigFile, null, 2),
        })
        set(s => ({
          configsByProject: { ...s.configsByProject, [project.id]: configs },
          loadedProjects: new Set(s.loadedProjects).add(project.id),
        }))
        return configs
      } catch (e) {
        set(s => ({
          configsByProject: { ...s.configsByProject, [project.id]: [] },
          loadedProjects: new Set(s.loadedProjects).add(project.id),
        }))
        if (e instanceof NotInTauriError) return []
        return []
      }
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
    if (config.tasks.length === 0) {
      useProjectStore.getState().pushToast(
        'error',
        `「${config.name}」没有可运行的任务`,
        `请检查 ${RUN_CONFIG_RELATIVE_PATH}，任务命令字段应为 target`
      )
      return
    }
    if (!(await ensureRunTrust(project, config))) return
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

export { runConfigPath, defaultConfigs, stripRedundantCdPrefix }
