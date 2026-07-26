import { isTauri, NotInTauriError } from './tauri'
import { translate } from './i18n'
import {
  ensureWorkspaceTrust,
  isProjectRestricted,
  isProjectTrusted,
  pushTrustedRootsToNative,
} from './workspaceTrust'
import { useProjectStore } from '../store/projectStore'
import {
  RUN_CONFIG_RELATIVE_PATH,
  useRunConfigStore,
  type RunConfig,
  type RunTask,
} from '../store/runConfigStore'
import { useTerminalStore, type ShellKind } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import type { Project, TerminalTab } from '../types'

/** Terminal still counts as a live run-config instance (incl. awaiting restore spawn). */
export function isActiveRunTerminal(
  terminal: Pick<TerminalTab, 'status' | 'awaitingRestoreSpawn'>
): boolean {
  return terminal.awaitingRestoreSpawn === true || terminal.status !== 'exited'
}

/** Tab title used when spawning a run-config task (must stay stable for legacy relink). */
export function runTaskTerminalName(
  config: Pick<RunConfig, 'name'>,
  task: Pick<RunTask, 'name'>
): string {
  return task.name ? `${config.name} · ${task.name}` : config.name
}

const RUN_TASK_SHELL_KINDS = new Set<string>(['ps1', 'bat', 'sh', 'command', 'script'])

export function findRunLinkageForTerminal(
  terminal: Pick<TerminalTab, 'name' | 'launchCommand' | 'shellKind' | 'runConfigId' | 'runTaskId'>,
  configs: RunConfig[]
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

/** Stamp restored/legacy task terminals once configs are available. */
export function rehydrateRunTerminals(configs?: RunConfig[]): number {
  if (!configs?.length) return 0
  const terminals = useTerminalStore.getState().terminals
  let stamped = 0
  const next = terminals.map(terminal => {
    if (terminal.runConfigId && terminal.runTaskId) return terminal
    const link = findRunLinkageForTerminal(terminal, configs)
    if (!link) return terminal
    stamped += 1
    return { ...terminal, ...link }
  })
  if (stamped > 0) useTerminalStore.setState({ terminals: next })
  return stamped
}

/** Active terminal ids are derived from terminal tabs; no second runtime map is maintained. */
export function activeTerminalsForConfig(
  configId: string,
  terminals: Array<Pick<TerminalTab, 'id' | 'runConfigId' | 'status' | 'awaitingRestoreSpawn'>>
): string[] {
  return terminals
    .filter(terminal => terminal.runConfigId === configId && isActiveRunTerminal(terminal))
    .map(terminal => terminal.id)
}

export function taskTerminalId(configId: string, taskId: string): string | undefined {
  return useTerminalStore
    .getState()
    .terminals.find(
      terminal =>
        terminal.runConfigId === configId &&
        terminal.runTaskId === taskId &&
        isActiveRunTerminal(terminal)
    )?.id
}

export function runningTaskKeysForConfig(configId: string): string[] {
  return useTerminalStore
    .getState()
    .terminals.filter(
      terminal =>
        terminal.runConfigId === configId && terminal.runTaskId && isActiveRunTerminal(terminal)
    )
    .map(terminal => `${configId}:${terminal.runTaskId}`)
}

export function isConfigRunning(configId: string): boolean {
  return activeTerminalsForConfig(configId, useTerminalStore.getState().terminals).length > 0
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')
  if (isAbsolute) return rel
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}${separator}${rel.replace(/[/\\]+$/, '')}`
}

async function ensureRunTrust(project: Project): Promise<boolean> {
  if (isProjectTrusted(project) || project.ephemeral) return true
  if (isProjectRestricted(project)) {
    useProjectStore
      .getState()
      .pushToast('info', translate('当前为受限模式，请先信任此项目后再运行'))
    return false
  }
  const level = await ensureWorkspaceTrust(project)
  if (level === false) return false
  await pushTrustedRootsToNative(useProjectStore.getState().projects)
  return level === 'trusted'
}

export async function runConfig(project: Project, config: RunConfig): Promise<void> {
  if (!isTauri()) {
    useProjectStore.getState().pushToast('error', new NotInTauriError('运行任务').message)
    return
  }
  if (config.tasks.length === 0) {
    useProjectStore
      .getState()
      .pushToast(
        'error',
        `「${config.name}」没有可运行的任务`,
        `请检查 ${RUN_CONFIG_RELATIVE_PATH}，任务命令字段应为 target`
      )
    return
  }
  if (!(await ensureRunTrust(project))) return

  const addScriptTerminal = useTerminalStore.getState().addScriptTerminal
  for (const task of config.tasks) {
    const cwd = task.cwd ? joinPath(project.path, task.cwd) : project.path
    await addScriptTerminal(
      project.id,
      cwd,
      task.type as ShellKind,
      task.target,
      task.env ?? {},
      runTaskTerminalName(config, task),
      { runConfigId: config.id, runTaskId: task.id }
    )
  }
  useUIStore.getState().openTerminalPanel()
}

export async function stopConfig(config: Pick<RunConfig, 'id'>): Promise<void> {
  const terminalIds = activeTerminalsForConfig(config.id, useTerminalStore.getState().terminals)
  const closeTerminal = useTerminalStore.getState().closeTerminal
  await Promise.all(terminalIds.map(id => closeTerminal(id).catch(() => undefined)))
}

export async function removeRunConfig(project: Project, configId: string): Promise<void> {
  const target = useRunConfigStore
    .getState()
    .configsByProject[project.id]?.find(config => config.id === configId)
  if (target) await stopConfig(target)
  await useRunConfigStore.getState().removeConfig(project, configId)
}
