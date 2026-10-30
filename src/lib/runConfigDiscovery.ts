import { scanDirectoryEntries, readFileSlice } from './fileIpc'
import type { RunConfig, RunTask } from '../store/runConfigStore'
import { translate } from './i18n'

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_CHILD_DIRECTORIES = 32
const MAX_SCRIPTS_PER_PACKAGE = 100
const IGNORED_DIRECTORIES = new Set([
  'node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage',
])
const MANAGER_LOCKS = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
} as const
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
type Entries = Awaited<ReturnType<typeof scanDirectoryEntries>>
type Manifest = { scripts?: unknown; packageManager?: unknown }

export interface DiscoveredRunTask {
  key: string
  name: string
  source: string
  script: string
  task: Omit<RunTask, 'id'>
}

export interface RunDiscoveryResult {
  tasks: DiscoveredRunTask[]
  warnings: { source: string; message: string }[]
}

function joinPath(root: string, name: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`
}

function lockManager(entries: Entries): PackageManager | undefined {
  const managers = new Set(entries.filter(entry => !entry.is_dir).flatMap(entry => {
    const manager = Object.prototype.hasOwnProperty.call(MANAGER_LOCKS, entry.name)
      ? MANAGER_LOCKS[entry.name as keyof typeof MANAGER_LOCKS] : undefined
    return manager ? [manager] : []
  }))
  if (managers.size > 1) throw new Error(translate('存在多个包管理器锁文件，请在 packageManager 中指定'))
  return [...managers][0]
}

function explicitManager(manifest: Manifest | undefined): PackageManager | undefined {
  if (manifest?.packageManager === undefined) return undefined
  if (typeof manifest.packageManager !== 'string') throw new Error(translate('packageManager 格式无效'))
  const match = /^(npm|pnpm|yarn|bun)@\S+$/.exec(manifest.packageManager)
  if (!match) throw new Error(translate('暂不支持此 packageManager，请手动配置命令'))
  return match[1] as PackageManager
}

/** Read-only, bounded discovery. No subprocesses, installs, recursive walk or automatic writes. */
export async function discoverRunTasks(root: string): Promise<RunDiscoveryResult> {
  const result: RunDiscoveryResult = { tasks: [], warnings: [] }
  const warn = (source: string, error: unknown) =>
    result.warnings.push({ source, message: error instanceof Error ? error.message : translate(String(error)) })
  const list = (path: string) => scanDirectoryEntries({
    path, workspaceRoot: root, excludePatterns: [], excludeGitIgnore: false,
  })
  const readManifest = async (directory: string, entries: Entries): Promise<Manifest | undefined> => {
    if (!entries.some(entry => entry.name === 'package.json' && !entry.is_dir)) return undefined
    const slice = await readFileSlice({
      path: joinPath(directory, 'package.json'), offset: 0, maxBytes: MAX_MANIFEST_BYTES,
    })
    if (slice.file_size > MAX_MANIFEST_BYTES) {
      throw new Error(translate('package.json 超过 256 KiB，请手动配置命令'))
    }
    if (!slice.eof) throw new Error(translate('package.json 未完整读取，请重试'))
    const manifest: unknown = JSON.parse(slice.text.replace(/^\uFEFF/, ''))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(translate('package.json 必须为 JSON 对象'))
    }
    return manifest as Manifest
  }
  // Root listing errors remain actionable; do not report an inaccessible project as empty.
  const rootEntries = await list(root)
  let inheritedManager: PackageManager | undefined
  const visit = async (directory: string, cwd: string, entries: Entries) => {
    const source = cwd ? `${cwd}/package.json` : 'package.json'
    try {
      const manifest = await readManifest(directory, entries)
      const manager = explicitManager(manifest) ?? lockManager(entries) ?? inheritedManager ?? 'npm'
      if (!cwd) inheritedManager = manager
      if (!manifest || manifest.scripts === undefined) return
      if (!manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) {
        throw new Error(translate('scripts 必须为 JSON 对象'))
      }
      const scripts = Object.entries(manifest.scripts)
      if (scripts.length > MAX_SCRIPTS_PER_PACKAGE) warn(source, '每个 package.json 最多发现 100 个脚本')
      for (const [name, script] of scripts.slice(0, MAX_SCRIPTS_PER_PACKAGE)) {
        // A portable unquoted shell argument; reject metacharacters, whitespace,
        // option-like names and Windows %/! expansion rather than guessing quoting.
        if (!/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(name)) {
          warn(source, translate('脚本名无法安全生成跨平台命令：{name}', { name }))
          continue
        }
        if (typeof script !== 'string' || !script.trim()) continue
        result.tasks.push({
          key: `${source}:${name}`,
          name: cwd ? `${cwd}: ${name}` : name,
          source,
          script,
          task: { name, type: 'command', target: `${manager} run ${name}`, ...(cwd ? { cwd } : {}) },
        })
      }
    } catch (error) {
      warn(source, error)
    }
  }
  await visit(root, '', rootEntries)
  const directories = rootEntries.filter(entry =>
    entry.is_dir && !entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(entry.name) &&
    !/[\\/\0]/.test(entry.name) && entry.name !== '..'
  ).sort((a, b) => a.name.localeCompare(b.name))
  if (directories.length > MAX_CHILD_DIRECTORIES) warn('.', '最多扫描 32 个直属子目录；更深目录请单独作为项目打开')
  // Sequential calls avoid flooding SSH sessions and keep warning/task ordering stable.
  for (const entry of directories.slice(0, MAX_CHILD_DIRECTORIES)) {
    const directory = joinPath(root, entry.name)
    try {
      await visit(directory, entry.name, await list(directory))
    } catch (error) {
      warn(entry.name, error)
    }
  }
  return result
}

function taskSignature(task: Pick<RunTask, 'cwd' | 'type' | 'target'>): string {
  return JSON.stringify([
    task.type, task.target?.trim() ?? '',
    (task.cwd ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, ''),
  ])
}

export function isDiscoveredTaskImported(task: DiscoveredRunTask, configs: RunConfig[]): boolean {
  return configs.some(config => config.tasks.some(existing =>
    taskSignature(existing) === taskSignature(task.task)
  ))
}

/** Re-check duplicates against the latest configs immediately before a single save. */
export function importDiscoveredTasks(
  configs: RunConfig[], tasks: DiscoveredRunTask[], combined: boolean
): RunConfig[] {
  const fresh = tasks.filter(task => !isDiscoveredTaskImported(task, configs))
  if (!fresh.length) return configs
  const createTask = (task: DiscoveredRunTask): RunTask => ({ ...task.task, id: crypto.randomUUID() })
  return [...configs, ...(combined ? [{
    id: crypto.randomUUID(), name: fresh.map(task => task.name).join(' + '),
    restoreWithProjectSession: false, tasks: fresh.map(createTask),
  }] : fresh.map(task => ({
    id: crypto.randomUUID(), name: task.name, restoreWithProjectSession: false,
    tasks: [createTask(task)],
  })))]
}
