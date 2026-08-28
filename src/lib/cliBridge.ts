import { listen } from '@tauri-apps/api/event'
import { safeInvoke, isTauri } from './tauri'
import { authorizePaths } from './pathAllowlist'
import { normalizeProjectPath, pushTrustedRootsToNative, trustProject } from './workspaceTrust'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import {
  runConfigPath,
  useRunConfigStore,
  type RunConfig,
  type RunTaskType,
} from '../store/runConfigStore'
import {
  isConfigRunning,
  runConfig,
  runningTaskKeysForConfig,
  stopConfig,
} from './runConfigRuntime'
import type { Project } from '../types'
import { ensureSshWorkspaceConnected } from './sshWorkspace'

interface CliRequest {
  id: string
  op: string
  project?: string | null
  config?: string | null
  path?: string | null
  paths?: string[] | null
  content?: string | null
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
        if (!target) throw new Error('each task.target is required')
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
    case 'project.switch': {
      const project = resolveProject(req.project)
      const ok = await useProjectStore.getState().switchProject(project)
      if (!ok) throw new Error('switch cancelled or failed')
      return { id: project.id, name: project.name, path: project.path }
    }
    case 'run.start': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      const config = await resolveConfig(project, req.config)
      await runConfig(project, config)
      return { project: project.path, config: { id: config.id, name: config.name } }
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
    case 'run.stop': {
      if (!req.config) throw new Error('config is required')
      const project = resolveProject(req.project)
      const config = await resolveConfig(project, req.config)
      await stopConfig(config)
      return { project: project.path, config: { id: config.id, name: config.name } }
    }
    case 'run.status': {
      const project = resolveProject(req.project)
      await ensureSshWorkspaceConnected(project)
      const configs = await useRunConfigStore.getState().loadConfigs(project)
      const running = configs.map(c => ({
        id: c.id,
        name: c.name,
        running: isConfigRunning(c.id),
        terminals: runningTaskKeysForConfig(c.id),
      }))
      return {
        project: { id: project.id, name: project.name, path: project.path },
        configs: running,
      }
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
    const unlisten = await listen<CliRequest>('cli-request', event => {
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
    return unlisten
  } catch {
    return () => {}
  }
}
