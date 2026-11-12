import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { safeInvoke, isTauri } from './tauri'
import { authorizePaths } from './pathAllowlist'
import {
  getWorkspaceTrust,
  isProjectTrusted,
  normalizeProjectPath,
  pushTrustedRootsToNative,
  trustedPathsOutsideProjects,
  trustProject,
  untrustProject,
} from './workspaceTrust'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { getTerminalRawScrollback, useTerminalStore } from '../store/terminalStore'
import {
  runConfigPath,
  useRunConfigStore,
  type RunConfig,
  type RunTask,
  type RunTaskType,
} from '../store/runConfigStore'
import {
  isConfigRunning,
  runConfig,
  runningTaskKeysForConfig,
  stopConfig,
} from './runConfigRuntime'
import { DEFAULT_TERMINAL_PROFILE, getEffectiveDefaultProfileId, loadTerminalProfileSettings, saveTerminalProfileSettings, type TerminalProfile } from './terminal/terminalProfiles'
import { forgetTerminalProfileTrust, isTerminalProfileTrusted } from './terminal/terminalProfileTrust'
import type { Project } from '../types'
import { ensureSshWorkspaceConnected } from './sshWorkspace'
import { exportSettings, importSettings, resetSettings } from './settingsTransfer'
import { hasRunTaskTarget, parseRunTaskOs } from './runTaskPlatform'
import { writeTerminal } from './ipc/terminal'
import {
  assertCliTerminalWritable,
  cliTerminalSummary,
  latestRunTerminals,
  readCliTerminal,
  resolveCliTerminal,
} from './terminal/cliTerminal'

import { availableTerminalShells, detectTerminalHostPlatform, isTerminalShellId } from './terminal/terminalShell'
import { loadScopedTerminalPersistLocalSessions } from './terminal/terminalPersistLocalSettings'
import { loadShellPrewarmCount } from './terminal/shellPrewarmSettings'

interface CliRequest {
  id: string
  op: string
  project?: string | null
  config?: string | null
  path?: string | null
  paths?: string[] | null
  content?: string | null
  options?: Record<string, unknown> | null
}

export function resolveCliProfileId(profiles: readonly TerminalProfile[], query: string): string {
  const key = query.trim()
  if (!key) throw new Error('terminal profile is required')
  const byId = profiles.find(profile => profile.id === key)
  if (byId) return byId.id
  const matches = profiles.filter(profile => profile.name.trim() === key)
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) throw new Error(`ambiguous terminal profile name '${key}'; use the profile id`)
  throw new Error(`terminal profile not found: ${key}`)
}

function optionString(req: CliRequest, key: string): string | undefined {
  const value = req.options?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function optionNumber(req: CliRequest, key: string): number | undefined {
  const value = req.options?.[key]
  return typeof value === 'number' ? value : undefined
}

function projectSummary(project: Project) {
  return { id: project.id, name: project.name, path: project.path }
}

/** 读写终端、启动进程等同于执行命令或查看其输出，都受工作区信任约束。 */
function requireTrusted(project: Project): void {
  if (!isProjectTrusted(project)) throw new Error(`project is not trusted: ${project.path}`)
}

export function selectCliRunTask(config: RunConfig, query?: string): RunTask | undefined {
  const q = query?.trim()
  if (!q) return undefined
  const byId = config.tasks.find(task => task.id === q)
  if (byId) return byId
  const byName = config.tasks.filter(task => task.name === q)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`ambiguous task name '${q}'; use the task id`)
  throw new Error(`task not found in run config: ${q}`)
}

function configWithTask(config: RunConfig, task: RunTask | undefined): RunConfig {
  return task ? { ...config, tasks: [task] } : config
}

const CLI_RUN_TASK_TYPES = new Set<RunTaskType>(['ps1', 'bat', 'sh', 'command', 'script'])

export function parseCliRunConfig(
  content: string,
  existing: RunConfig[]
): { action: 'created' | 'updated'; config: RunConfig } {
  const parsed = JSON.parse(content) as unknown
  const candidate =
    parsed && typeof parsed === 'object' && 'config' in parsed
      ? (parsed as { config?: unknown }).config
      : parsed
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('json must be a run config object')
  }
  const value = candidate as Partial<RunConfig>
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) throw new Error('config.name is required')
  const requestedId = typeof value.id === 'string' ? value.id.trim() : ''
  const previous =
    (requestedId ? existing.find(config => config.id === requestedId) : undefined) ??
    existing.find(config => config.name === name)
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map((task, index) => {
        if (!task || typeof task !== 'object') throw new Error(`tasks[${index}] is invalid`)
        const target = typeof task.target === 'string' ? task.target.trim() : ''
        const os = parseRunTaskOs(task.os)
        if (!hasRunTaskTarget({ target, os }))
          throw new Error('each task.target is required (common or os override)')
        const rawType = typeof task.type === 'string' ? task.type : 'command'
        const type = CLI_RUN_TASK_TYPES.has(rawType as RunTaskType)
          ? (rawType as RunTaskType)
          : 'command'
        const env = task.env
        if (
          env &&
          (typeof env !== 'object' ||
            Array.isArray(env) ||
            Object.values(env).some(item => typeof item !== 'string'))
        ) {
          throw new Error(`tasks[${index}].env must contain string values`)
        }
        return {
          id: typeof task.id === 'string' && task.id.trim() ? task.id.trim() : crypto.randomUUID(),
          name: typeof task.name === 'string' && task.name.trim() ? task.name.trim() : undefined,
          type,
          target,
          cwd: typeof task.cwd === 'string' && task.cwd.trim() ? task.cwd.trim() : undefined,
          env: env as Record<string, string> | undefined,
          ...(os ? { os } : {}),
        }
      })
    : []
  return {
    action: previous ? 'updated' : 'created',
    config: {
      id: (previous?.id ?? requestedId) || crypto.randomUUID(),
      name,
      restoreWithProjectSession: value.restoreWithProjectSession === true,
      tasks,
    },
  }
}

function normalizePath(path: string): string {
  return normalizeProjectPath(path)
}

function resolveProject(query?: string | null): Project {
  const projects = useProjectStore.getState().projects.filter(p => !p.ephemeral)
  if (!query) {
    const current = useProjectStore.getState().currentProject
    if (current && !current.ephemeral) return current
    if (projects.length === 1) return projects[0]
    if (projects.length === 0) throw new Error('no projects loaded')
    throw new Error(`multiple projects (${projects.length}); pass project id|path|name`)
  }
  const q = query.trim()
  const byId = projects.find(p => p.id === q)
  if (byId) return byId
  const nq = normalizePath(q)
  const byPath = projects.filter(p => normalizePath(p.path) === nq)
  if (byPath.length === 1) return byPath[0]
  if (byPath.length > 1) throw new Error(`ambiguous project path: ${q}`)
  const byName = projects.filter(p => p.name === q)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`ambiguous project name '${q}'`)
  throw new Error(`project not found: ${q}`)
}

async function resolveConfig(project: Project, query: string) {
  await ensureSshWorkspaceConnected(project)
  const configs = await useRunConfigStore.getState().loadConfigs(project)
  const q = query.trim()
  const byId = configs.find(c => c.id === q)
  if (byId) return byId
  const byName = configs.filter(c => c.name === q)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`ambiguous run config name '${q}'`)
  throw new Error(`run config not found: ${q}`)
}

/** Parse `file[:line[:col]]`, including Windows `D:\path\file.ts:10:2`. */
export function parseOpenTarget(target: string): {
  path: string
  line?: number
  column?: number
} {
  const win = target.match(/^([A-Za-z]:[/\\].+?):(\d+)(?::(\d+))?$/)
  if (win) {
    return {
      path: win[1],
      line: Number(win[2]),
      column: win[3] ? Number(win[3]) : undefined,
    }
  }
  const m = target.match(/^(.*?):(\d+)(?::(\d+))?$/)
  if (!m) return { path: target }
  // Avoid treating `D:` alone as path:line
  if (/^[A-Za-z]:$/.test(m[1])) return { path: target }
  return {
    path: m[1],
    line: Number(m[2]),
    column: m[3] ? Number(m[3]) : undefined,
  }
}

async function handleRequest(req: CliRequest): Promise<unknown> {
  switch (req.op) {
    case 'settings.export':
    case 'settings.import': {
      if (req.config !== 'user' && req.config !== 'workspace')
        throw new Error('invalid settings scope')
      const scope = req.config === 'user' ? 'global' : 'project'
      const project = scope === 'project' ? resolveProject(req.project) : null
      if (project) await ensureSshWorkspaceConnected(project)
      if (req.op === 'settings.export') return exportSettings(scope, project)
      if (!req.content) throw new Error('content is required')
      return importSettings(req.content, scope, project)
    }
    case 'settings.reset': {
      if (req.config !== 'user' && req.config !== 'workspace')
        throw new Error('invalid settings scope')
      const scope = req.config === 'user' ? 'global' : 'project'
      const project = scope === 'project' ? resolveProject(req.project) : null
      if (project) await ensureSshWorkspaceConnected(project)
      return resetSettings(scope, project)
    }
    case 'app.status': {
      const { currentProject, projects } = useProjectStore.getState()
      return {
        currentProject:
          currentProject && !currentProject.ephemeral ? projectSummary(currentProject) : null,
        projects: projects.filter(p => !p.ephemeral).length,
        terminals: useTerminalStore.getState().terminals.length,
      }
    }
    case 'projects.reload': {
      await useProjectStore.getState().reloadProjectsAfterExternalChange()
      return { count: useProjectStore.getState().projects.filter(p => !p.ephemeral).length }
    }
    case 'run.reload': {
      const project = resolveProject(req.project)
      const configs = await useRunConfigStore.getState().loadConfigs(project)
      return { count: configs.length }
    }
    case 'project.switch': {
      const project = resolveProject(req.project)
      const ok = await useProjectStore.getState().switchProject(project)
      if (!ok) throw new Error('switch cancelled or failed')
      return { id: project.id, name: project.name, path: project.path }
    }
    case 'run.start':
    case 'run.task.start': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      const config = await resolveConfig(project, req.config)
      const selected = configWithTask(config, selectCliRunTask(config, optionString(req, 'task')))
      const result = await runConfig(project, selected, { throwOnError: true, promptTrust: false })
      return { project: project.path, config: { id: config.id, name: config.name }, ...result }
    }
    case 'run.restart': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      // 先检查信任，避免停掉任务后才发现无法重新启动。
      requireTrusted(project)
      const config = await resolveConfig(project, req.config)
      const task = selectCliRunTask(config, optionString(req, 'task'))
      await stopConfig(config, project.id, task?.id)
      const result = await runConfig(project, configWithTask(config, task), {
        throwOnError: true,
        promptTrust: false,
      })
      return { project: project.path, config: { id: config.id, name: config.name }, ...result }
    }
    case 'run.logs': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      requireTrusted(project)
      const config = await resolveConfig(project, req.config)
      const task = selectCliRunTask(config, optionString(req, 'task'))
      const tail = optionNumber(req, 'tail')
      const terminals = latestRunTerminals(
        useTerminalStore
          .getState()
          .terminals.filter(
            terminal =>
              terminal.projectId === project.id &&
              terminal.runConfigId === config.id &&
              (!task || terminal.runTaskId === task.id)
          )
      )
      return {
        project: projectSummary(project),
        config: { id: config.id, name: config.name },
        tasks: await Promise.all(
          terminals.map(async terminal => ({
            id: terminal.runTaskId,
            terminalId: terminal.id,
            status: terminal.status,
            exitCode: terminal.exitCode,
            ...(await readCliTerminal(terminal.id, 'buffer', tail, () =>
              getTerminalRawScrollback(terminal.id)
            )),
          }))
        ),
      }
    }
    case 'run.list': {
      const project = resolveProject(req.project)
      await ensureSshWorkspaceConnected(project)
      const configs = await useRunConfigStore.getState().loadConfigs(project)
      return {
        project: { id: project.id, name: project.name, path: project.path },
        path: runConfigPath(project),
        configs,
      }
    }
    case 'run.get': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      const config = await resolveConfig(project, req.config)
      return { project: { id: project.id, name: project.name, path: project.path }, config }
    }
    case 'run.upsert': {
      if (!req.content) throw new Error('content is required')
      const project = resolveProject(req.project)
      await ensureSshWorkspaceConnected(project)
      const existing = await useRunConfigStore.getState().loadConfigs(project)
      const result = parseCliRunConfig(req.content, existing)
      await useRunConfigStore.getState().upsertConfig(project, result.config)
      return {
        project: { id: project.id, name: project.name, path: project.path },
        ...result,
      }
    }
    case 'run.remove': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      const target = await resolveConfig(project, req.config)
      const existing = useRunConfigStore.getState().configsByProject[project.id] ?? []
      await useRunConfigStore.getState().saveConfigs(
        project,
        existing.filter(config => config.id !== target.id)
      )
      return {
        project: { id: project.id, name: project.name, path: project.path },
        removed: target,
      }
    }
    case 'run.stop':
    case 'run.task.stop': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      const config = await resolveConfig(project, req.config)
      const task = selectCliRunTask(config, optionString(req, 'task'))
      await stopConfig(config, project.id, task?.id)
      return { project: project.path, config: { id: config.id, name: config.name } }
    }
    case 'run.status': {
      const project = resolveProject(req.project)
      await ensureSshWorkspaceConnected(project)
      const configs = await useRunConfigStore.getState().loadConfigs(project)
      const running = configs.map(c => ({
        id: c.id,
        name: c.name,
        running: isConfigRunning(c.id, project.id),
        terminals: runningTaskKeysForConfig(c.id, project.id),
        tasks: useTerminalStore
          .getState()
          .terminals.filter(
            terminal => terminal.projectId === project.id && terminal.runConfigId === c.id
          )
          .map(terminal => ({
            id: terminal.runTaskId,
            terminalId: terminal.id,
            status: terminal.status,
            exitCode: terminal.exitCode,
            environment: terminal.runEnvironment,
            target: terminal.launchCommand,
            cwd: terminal.cwd,
          })),
      }))
      return {
        project: { id: project.id, name: project.name, path: project.path },
        configs: running,
      }
    }
    case 'terminal.profile.upsert': {
      const value = JSON.parse((req.content ?? '').replace(/^\uFEFF/, '')) as Partial<TerminalProfile> | null
      if (!value || typeof value.name !== 'string' || !value.name.trim() || typeof value.command !== 'string') {
        throw new Error('profile requires a nonempty name and a command string')
      }
      if (value.id !== undefined && (typeof value.id !== 'string' || !value.id.trim())) throw new Error('invalid profile id')
      const settings = loadTerminalProfileSettings()
      const name = value.name.trim()
      const matches = settings.profiles.filter(p => p.name.trim() === name)
      if (!value.id && matches.length > 1) throw new Error('ambiguous profile name; supply an id')
      const requestedId = value.id?.trim()
      const previous = requestedId ? settings.profiles.find(p => p.id === requestedId) : matches[0]
      const id = previous?.id ?? requestedId ?? crypto.randomUUID()
      if (id === DEFAULT_TERMINAL_PROFILE.id) throw new Error('the built-in profile cannot be edited')
      const shell = value.shell ?? previous?.shell ?? settings.defaultShell
      if (!isTerminalShellId(shell) || !availableTerminalShells().includes(shell)) throw new Error('unsupported profile shell')
      const profile = { id, name, command: value.command, shell }
      if (!previous || previous.shell !== shell || previous.command !== profile.command) forgetTerminalProfileTrust(id)
      saveTerminalProfileSettings({ ...settings, profiles: previous
        ? settings.profiles.map(item => item.id === id ? profile : item) : [...settings.profiles, profile] })
      return { id, name, shell, trusted: isTerminalProfileTrusted(profile) }
    }
    case 'terminal.profile.get':
    case 'terminal.profile.default':
    case 'terminal.profile.remove': {
      const settings = loadTerminalProfileSettings()
      const id = resolveCliProfileId(settings.profiles, req.config ?? '')
      if (req.op === 'terminal.profile.get') {
        const profile = settings.profiles.find(item => item.id === id)!
        return { ...profile, trusted: isTerminalProfileTrusted(profile) }
      }
      if (req.op === 'terminal.profile.default') {
        saveTerminalProfileSettings({ ...settings, defaultProfileId: id === DEFAULT_TERMINAL_PROFILE.id ? null : id })
        return { defaultProfileId: id }
      }
      if (id === DEFAULT_TERMINAL_PROFILE.id) throw new Error('the built-in profile cannot be removed')
      forgetTerminalProfileTrust(id)
      saveTerminalProfileSettings({ ...settings, profiles: settings.profiles.filter(p => p.id !== id),
        defaultProfileId: settings.defaultProfileId === id ? null : settings.defaultProfileId })
      return { removed: id }
    }
    case 'terminal.diagnostics': {
      const project = resolveProject(req.project)
      const tab = resolveCliTerminal(useTerminalStore.getState().terminals, project.id, req.config ?? '')
      return { project: projectSummary(project), terminal: cliTerminalSummary(tab),
        prewarm: tab.prewarm ?? { outcome: 'unknown', reason: 'no_observation' } }
    }
    case 'terminal.prewarmStatus': {
      const project = resolveProject(req.project)
      const pool = await safeInvoke<{ target: number; ready: number; preparing: number; reserved: number; reason: string | null }>(
        '读取 Shell 预热状态', 'shell_prewarm_status', { cwd: project.path })
      const configured = await loadShellPrewarmCount()
      let reason = pool.reason
      if (!pool.target) {
        const local = !project.path.startsWith('ssh://')
        if (!isProjectTrusted(project)) reason = 'untrusted'
        else if (configured === 0) reason = 'disabled'
        else if (project.ephemeral || (local && detectTerminalHostPlatform() !== 'win')) reason = 'unsupported_host'
        else if (local && loadTerminalProfileSettings().defaultShell === 'wsl') reason = 'unsupported_shell'
        else if (local && !await loadScopedTerminalPersistLocalSessions('project', project)) reason = 'persistence_disabled'
      }
      return { project: projectSummary(project), configured, ...pool, reason }
    }
    case 'terminal.profiles': {
      const settings = loadTerminalProfileSettings()
      return {
        defaultProfileId: getEffectiveDefaultProfileId(settings),
        profiles: settings.profiles.map(profile => ({
          id: profile.id, name: profile.name, shell: profile.shell, trusted: isTerminalProfileTrusted(profile),
        })),
      }
    }
    case 'terminal.list': {
      const project = resolveProject(req.project)
      return {
        project: { id: project.id, name: project.name, path: project.path },
        trusted: isProjectTrusted(project),
        terminals: useTerminalStore
          .getState()
          .terminals.filter(terminal => terminal.projectId === project.id)
          .map(cliTerminalSummary),
      }
    }
    case 'terminal.send': {
      if (!req.config) throw new Error('terminal is required')
      if (!req.content) throw new Error('content is required')
      const project = resolveProject(req.project)
      requireTrusted(project)
      const terminal = resolveCliTerminal(
        useTerminalStore.getState().terminals,
        project.id,
        req.config
      )
      assertCliTerminalWritable(terminal)
      await writeTerminal(terminal.id, req.content)
      return {
        project: { id: project.id, name: project.name, path: project.path },
        terminal: { id: terminal.id, name: terminal.name },
        bytes: new TextEncoder().encode(req.content).length,
      }
    }
    case 'terminal.read': {
      if (!req.config) throw new Error('terminal is required')
      const project = resolveProject(req.project)
      requireTrusted(project)
      const terminal = resolveCliTerminal(
        useTerminalStore.getState().terminals,
        project.id,
        req.config
      )
      const scope = optionString(req, 'scope') === 'screen' ? 'screen' : 'buffer'
      const { available, ...output } = await readCliTerminal(
        terminal.id,
        scope,
        optionNumber(req, 'tail'),
        () => getTerminalRawScrollback(terminal.id)
      )
      if (!available) throw new Error(`terminal output is not available yet: ${terminal.id}`)
      return {
        project: projectSummary(project),
        terminal: cliTerminalSummary(terminal),
        scope,
        ...output,
      }
    }
    case 'terminal.create':
    case 'terminal.createProfile': {
      const project = resolveProject(req.project)
      requireTrusted(project)
      await ensureSshWorkspaceConnected(project)
      const profileId = req.op === 'terminal.createProfile'
        ? resolveCliProfileId(loadTerminalProfileSettings().profiles, req.config ?? '')
        : undefined
      const id = await useTerminalStore.getState().addTerminal(project.path, project.id, profileId)
      const terminal = useTerminalStore.getState().terminals.find(item => item.id === id)
      if (!terminal) throw new Error('could not create a terminal (cancelled, limit reached or app closing)')
      return { project: projectSummary(project), terminal: cliTerminalSummary(terminal) }
    }
    case 'terminal.restart': {
      if (!req.config) throw new Error('terminal is required')
      const project = resolveProject(req.project)
      requireTrusted(project)
      const { id } = resolveCliTerminal(
        useTerminalStore.getState().terminals,
        project.id,
        req.config
      )
      await useTerminalStore.getState().restartTerminal(id)
      const terminal = useTerminalStore.getState().terminals.find(item => item.id === id)
      if (!terminal) throw new Error(`terminal not found after restart: ${id}`)
      return { project: projectSummary(project), terminal: cliTerminalSummary(terminal) }
    }
    case 'terminal.close': {
      if (!req.config) throw new Error('terminal is required')
      const project = resolveProject(req.project)
      const terminal = resolveCliTerminal(
        useTerminalStore.getState().terminals,
        project.id,
        req.config
      )
      await useTerminalStore.getState().closeTerminal(terminal.id)
      // closeTerminal 失败时只提示不抛错，需要确认标签确实已关闭。
      if (useTerminalStore.getState().terminals.some(item => item.id === terminal.id)) {
        throw new Error(`could not close terminal: ${terminal.id}`)
      }
      return {
        project: projectSummary(project),
        closed: { id: terminal.id, name: terminal.name },
      }
    }
    case 'trust.list': {
      const projects = useProjectStore.getState().projects.filter(p => !p.ephemeral)
      return {
        projects: projects.map(project => ({
          ...projectSummary(project),
          trust: getWorkspaceTrust(project),
        })),
        trustedPathsOutsideProjects: trustedPathsOutsideProjects(projects),
      }
    }
    case 'trust.revoke': {
      if (!req.path) throw new Error('path is required')
      const projects = useProjectStore.getState().projects
      const n = normalizePath(req.path)
      const match = projects.find(p => normalizePath(p.path) === n)
      untrustProject(match ?? { id: `cli:${n}`, path: req.path })
      await pushTrustedRootsToNative(projects)
      return { path: match?.path ?? req.path, trusted: false }
    }
    case 'trust.grant': {
      if (!req.path) throw new Error('path is required')
      const projects = useProjectStore.getState().projects
      const n = normalizePath(req.path)
      const match = projects.find(p => normalizePath(p.path) === n)
      if (match) {
        trustProject(match)
        await pushTrustedRootsToNative(projects)
        return { path: match.path, id: match.id, trusted: true }
      }
      trustProject({ id: `cli:${n}`, path: req.path })
      await pushTrustedRootsToNative(useProjectStore.getState().projects)
      return { path: req.path, trusted: true }
    }
    case 'open': {
      const targets = req.paths ?? []
      if (targets.length === 0) throw new Error('paths required')
      const parsed = targets.map(parseOpenTarget)
      await authorizePaths(parsed.map(p => p.path))
      for (const item of parsed) {
        await useEditorStore.getState().openFile(item.path, item.line, item.column)
      }
      return { opened: parsed }
    }
    default:
      throw new Error(`unknown op: ${req.op}`)
  }
}

async function respond(id: string, ok: boolean, data?: unknown, error?: string): Promise<void> {
  await safeInvoke('回复 CLI 请求', 'resolve_cli_request', {
    id,
    ok,
    data: data ?? null,
    error: error ?? null,
  })
}

/** Listen for IPC CLI requests from `qingcode.exe` subcommands. */
export async function listenForCliRequests(): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    // 全局 listen 不区分目标窗口：独立文件窗口也会收到，同一请求会被执行多次。
    const unlisten = await getCurrentWebviewWindow().listen<CliRequest>('cli-request', event => {
      const req = event.payload
      void (async () => {
        try {
          const data = await handleRequest(req)
          await respond(req.id, true, data)
        } catch (e) {
          await respond(req.id, false, undefined, String(e))
        }
      })()
    })
    void safeInvoke('标记 CLI 桥接就绪', 'cli_bridge_ready').catch(error => {
      console.warn('cli bridge ready failed:', error)
    })
    return unlisten
  } catch {
    return () => {}
  }
}
