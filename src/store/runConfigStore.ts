import { create } from 'zustand'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import { translate } from '../lib/i18n'
import {
  ensureWorkspaceTrust,
  isProjectRestricted,
  isProjectTrusted,
  pushTrustedRootsToNative,
} from '../lib/workspaceTrust'
import { useProjectStore } from './projectStore'
import { useTerminalStore, type ShellKind } from './terminalStore'
import { useUIStore } from './uiStore'
import type { Project, TerminalTab } from '../types'

/** Terminal still counts as a live run-config instance (incl. awaiting restore spawn). */
export function isActiveRunTerminal(
  t: Pick<TerminalTab, 'status' | 'awaitingRestoreSpawn'>,
): boolean {
  return t.awaitingRestoreSpawn === true || t.status !== 'exited'
}

/** Tab title used when spawning a run-config task (must stay stable for legacy relink). */
export function runTaskTerminalName(
  config: Pick<RunConfig, 'name'>,
  task: Pick<RunTask, 'name'>,
): string {
  return task.name ? `${config.name} · ${task.name}` : config.name
}

const RUN_TASK_SHELL_KINDS = new Set<string>(['ps1', 'bat', 'sh', 'command', 'script'])

/**
 * Resolve run-config linkage for a terminal. Prefers stamped ids; otherwise
 * recovers from the stable tab name (and uniquely matching launchCommand).
 */
export function findRunLinkageForTerminal(
  terminal: Pick<TerminalTab, 'name' | 'launchCommand' | 'shellKind' | 'runConfigId' | 'runTaskId'>,
  configs: RunConfig[],
): { runConfigId: string; runTaskId: string } | null {
  if (terminal.runConfigId && terminal.runTaskId) {
    return { runConfigId: terminal.runConfigId, runTaskId: terminal.runTaskId }
  }
  if (!terminal.shellKind || !RUN_TASK_SHELL_KINDS.has(terminal.shellKind)) return null

  for (const config of configs) {
    for (const task of config.tasks) {
      if (terminal.name === runTaskTerminalName(config, task)) {
        return { runConfigId: config.id, runTaskId: task.id }
      }
    }
  }

  if (!terminal.launchCommand) return null
  const byCommand: Array<{ runConfigId: string; runTaskId: string }> = []
  for (const config of configs) {
    for (const task of config.tasks) {
      if (task.target === terminal.launchCommand) {
        byCommand.push({ runConfigId: config.id, runTaskId: task.id })
      }
    }
  }
  return byCommand.length === 1 ? byCommand[0] : null
}

/**
 * Stamp runConfigId/runTaskId onto restored/legacy task terminals that lack them.
 * Returns how many tabs were updated.
 */
export function stampMissingRunLinkage(configs: RunConfig[]): number {
  if (configs.length === 0) return 0
  const terminals = useTerminalStore.getState().terminals
  let stamped = 0
  const next = terminals.map(t => {
    if (t.runConfigId && t.runTaskId) return t
    const link = findRunLinkageForTerminal(t, configs)
    if (!link) return t
    stamped += 1
    return { ...t, runConfigId: link.runConfigId, runTaskId: link.runTaskId }
  })
  if (stamped > 0) useTerminalStore.setState({ terminals: next })
  return stamped
}

/** Active terminals belonging to a run config (source of truth for UI / stop). */
export function activeTerminalsForConfig(
  configId: string,
  terminals: Array<Pick<TerminalTab, 'id' | 'runConfigId' | 'status' | 'awaitingRestoreSpawn'>>,
): string[] {
  return terminals
    .filter(t => t.runConfigId === configId && isActiveRunTerminal(t))
    .map(t => t.id)
}

/** Rebuild in-memory run maps from terminals that carry runConfigId/runTaskId. */
export function buildRunningMapsFromTerminals(
  terminals: Array<
    Pick<TerminalTab, 'id' | 'runConfigId' | 'runTaskId' | 'status' | 'awaitingRestoreSpawn'>
  >,
): { runningByTask: Record<string, string>; runningConfigs: Record<string, string[]> } {
  const runningByTask: Record<string, string> = {}
  const runningConfigs: Record<string, string[]> = {}
  for (const t of terminals) {
    if (!t.runConfigId || !t.runTaskId) continue
    if (!isActiveRunTerminal(t)) continue
    const key = `${t.runConfigId}:${t.runTaskId}`
    runningByTask[key] = t.id
    const list = runningConfigs[t.runConfigId] ?? []
    if (!list.includes(key)) list.push(key)
    runningConfigs[t.runConfigId] = list
  }
  return { runningByTask, runningConfigs }
}

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

/** Legacy workspace run-config path (former product id `.nestcode/`). Kept as a
 * read-only fallback in `loadConfigs` so projects that still only carry a
 * `.nestcode/run.json` auto-migrate to `.qingcode/run.json`; not deleted because
 * user workspace files may persist long after the app rename. */
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

async function ensureRunTrust(project: Project): Promise<boolean> {
  if (isProjectTrusted(project) || project.ephemeral) return true
  if (isProjectRestricted(project)) {
    useProjectStore
      .getState()
      .pushToast('info', translate('当前为受限模式，请先信任此项目后再运行'))
    return false
  }
  // Undecided should be rare (trust is asked on project open).
  const level = await ensureWorkspaceTrust(project)
  if (level === false) return false
  await pushTrustedRootsToNative(useProjectStore.getState().projects)
  return level === 'trusted'
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
    if (!target) return

    useProjectStore.getState().pushToast(
      'success',
      translate('已删除运行配置「{name}」', { name: target.name }),
      undefined,
      {
        label: translate('撤销'),
        onAction: async () => {
          const latest = get().configsByProject[project.id] ?? []
          if (latest.some(config => config.id === target.id)) return
          try {
            await get().saveConfigs(project, [...latest, target])
            useProjectStore
              .getState()
              .pushToast('success', translate('已恢复运行配置「{name}」', { name: target.name }))
          } catch {
            // saveConfigs has already shown the actionable error toast.
          }
        },
      },
    )
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
    if (!(await ensureRunTrust(project))) return
    const addScriptTerminal = useTerminalStore.getState().addScriptTerminal
    const taskKeys: string[] = []
    for (const task of config.tasks) {
      const cwd = task.cwd ? joinPath(project.path, task.cwd) : project.path
      const name = runTaskTerminalName(config, task)
      const terminalId = await addScriptTerminal(
        project.id,
        cwd,
        task.type as ShellKind,
        task.target,
        task.env ?? {},
        name,
        { runConfigId: config.id, runTaskId: task.id },
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
    const kill = useTerminalStore.getState().closeTerminal
    const tids = new Set(
      activeTerminalsForConfig(config.id, useTerminalStore.getState().terminals),
    )
    for (const key of get().runningConfigs[config.id] ?? []) {
      const tid = get().runningByTask[key]
      if (tid) tids.add(tid)
    }
    await Promise.all([...tids].map(tid => kill(tid).catch(() => undefined)))
    get().clearStopped(config)
  },

  isConfigRunning: (configId: string) =>
    activeTerminalsForConfig(configId, useTerminalStore.getState().terminals).length > 0,

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

/**
 * Apply run-config ↔ terminal linkage after session hydrate or when configs load.
 * Pass configs to recover legacy restored tabs that lack stamped runConfigId.
 */
export function rehydrateRunningFromTerminals(configs?: RunConfig[]): void {
  if (configs && configs.length > 0) stampMissingRunLinkage(configs)
  const { runningByTask, runningConfigs } = buildRunningMapsFromTerminals(
    useTerminalStore.getState().terminals,
  )
  useRunConfigStore.setState({ runningByTask, runningConfigs })
}

export { runConfigPath, defaultConfigs, stripRedundantCdPrefix }
