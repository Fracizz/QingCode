import { create } from 'zustand'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import { translate } from '../lib/i18n'
import { useProjectStore } from './projectStore'
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
  /** Restore and restart linked task terminals with the durable project session. */
  restoreWithProjectSession?: boolean
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

function normalizeConfigs(input: unknown): RunConfig[] {
  if (!input || typeof input !== 'object') return []
  const file = input as Partial<RunConfigFile>
  const configs = Array.isArray(file.configs) ? file.configs : []
  return configs
    .filter(c => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map(c => ({
      id: c.id,
      name: c.name,
      restoreWithProjectSession: c.restoreWithProjectSession === true,
      tasks: Array.isArray(c.tasks)
        ? (c.tasks.map(normalizeTask).filter(Boolean) as RunTask[])
        : [],
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

function defaultConfigs(): RunConfig[] {
  return [
    {
      id: crypto.randomUUID(),
      name: '前后端',
      restoreWithProjectSession: false,
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

  loadConfigs: (project: Project) => Promise<RunConfig[]>
  saveConfigs: (project: Project, configs: RunConfig[]) => Promise<void>
  upsertConfig: (project: Project, config: RunConfig) => Promise<void>
  removeConfig: (project: Project, configId: string) => Promise<void>
}

export const useRunConfigStore = create<RunConfigState>((set, get) => ({
  configsByProject: {},
  loadedProjects: new Set<string>(),

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
    const next =
      idx >= 0 ? current.map(c => (c.id === config.id ? config : c)) : [...current, config]
    await get().saveConfigs(project, next)
  },

  removeConfig: async (project: Project, configId: string) => {
    const current = get().configsByProject[project.id] ?? []
    const target = current.find(c => c.id === configId)
    const next = current.filter(c => c.id !== configId)
    await get().saveConfigs(project, next)
    if (!target) return

    useProjectStore
      .getState()
      .pushToast(
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
        }
      )
  },
}))

export { runConfigPath, defaultConfigs, stripRedundantCdPrefix }

/** Session restore is opt-in; older run.json files without the field stay disabled. */
export function runConfigFollowsProjectSession(config: Pick<RunConfig, 'restoreWithProjectSession'>) {
  return config.restoreWithProjectSession === true
}
