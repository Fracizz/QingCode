import type { RunOs, RunStartTask, RunTaskOverride, RunTaskType } from './types'

// `.qingcode/run.json` 的解析、序列化、校验与自动发现（纯函数）。
// 与旧版（D:\code\qingcode 的 runConfigStore / CLI run_config.rs）格式完全兼容：
// 未知字段原样保留，`task.os` 是按系统的覆盖对象 `{windows:{target,...}}`；
// 也接受任务卡里的字符串写法 `"os":"windows"`（视为仅限该系统）。

export const RUN_TASK_TYPES: readonly RunTaskType[] = ['command', 'ps1', 'bat', 'sh', 'script']
export const RUN_OS: readonly RunOs[] = ['windows', 'linux', 'macos']
export const RUN_CONFIG_RELATIVE_PATH = '.qingcode/run.json'

export const TASK_TYPE_LABEL: Record<RunTaskType, string> = {
  command: '命令',
  ps1: 'PowerShell',
  bat: 'BAT',
  sh: 'sh',
  script: '脚本',
}

export const OS_LABEL: Record<RunOs, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS' }

export type RunTaskOs = Partial<Record<RunOs, RunTaskOverride & Record<string, unknown>>>

export type RunTask = {
  id: string
  name?: string
  type: RunTaskType
  target: string
  cwd?: string
  env?: Record<string, string>
  os?: RunTaskOs | RunOs
  /** 本程序不认识的字段，序列化时原样写回 */
  extra?: Record<string, unknown>
}

export type RunConfig = {
  id: string
  name: string
  restoreWithProjectSession?: boolean
  tasks: RunTask[]
  extra?: Record<string, unknown>
  /** 解析不了的任务原样保留，写回时附在末尾 */
  rawTasks?: unknown[]
}

export type RunConfigFile = {
  configs: RunConfig[]
  extra?: Record<string, unknown>
  /** 缺 id/name 的配置原样保留 */
  rawConfigs?: unknown[]
}

export type ParseResult = { ok: true; file: RunConfigFile } | { ok: false; error: string }

const TASK_KEYS = new Set(['id', 'name', 'type', 'target', 'cwd', 'env', 'os'])
const CONFIG_KEYS = new Set(['id', 'name', 'restoreWithProjectSession', 'tasks'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickExtra(source: Record<string, unknown>, known: Set<string>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) if (!known.has(key)) extra[key] = value
  return Object.keys(extra).length > 0 ? extra : undefined
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') env[key] = item
  return env
}

export function isRunOs(value: unknown): value is RunOs {
  return typeof value === 'string' && RUN_OS.includes(value as RunOs)
}

function isTaskType(value: unknown): value is RunTaskType {
  return typeof value === 'string' && RUN_TASK_TYPES.includes(value as RunTaskType)
}

function parseOs(value: unknown): RunTask['os'] {
  if (isRunOs(value)) return value
  if (!isRecord(value)) return undefined
  const result: RunTaskOs = {}
  for (const [os, fields] of Object.entries(value)) {
    if (!isRunOs(os) || !isRecord(fields)) continue
    const override: RunTaskOverride & Record<string, unknown> = { ...fields }
    if (fields.type !== undefined && !isTaskType(fields.type)) delete override.type
    for (const key of ['target', 'cwd'] as const) {
      if (typeof fields[key] === 'string') override[key] = (fields[key] as string).trim()
      else delete override[key]
    }
    if (fields.env !== undefined) {
      const env = parseEnv(fields.env)
      if (env) override.env = env
      else delete override.env
    }
    result[os] = override
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function parseTask(value: unknown): RunTask | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  const task: RunTask = {
    id: value.id,
    type: isTaskType(value.type) ? value.type : 'command',
    target: typeof value.target === 'string' ? value.target.trim() : '',
  }
  if (typeof value.name === 'string') task.name = value.name
  if (typeof value.cwd === 'string' && value.cwd.trim()) task.cwd = value.cwd.trim()
  const env = parseEnv(value.env)
  if (env && Object.keys(env).length > 0) task.env = env
  const os = parseOs(value.os)
  if (os) task.os = os
  const extra = pickExtra(value, TASK_KEYS)
  if (extra) task.extra = extra
  return task
}

export function parseConfig(value: unknown): RunConfig | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string') return null
  const tasks: RunTask[] = []
  const rawTasks: unknown[] = []
  for (const item of Array.isArray(value.tasks) ? value.tasks : []) {
    const task = parseTask(item)
    if (task) tasks.push(task)
    else rawTasks.push(item)
  }
  const config: RunConfig = { id: value.id, name: value.name, tasks }
  if (value.restoreWithProjectSession === true) config.restoreWithProjectSession = true
  const extra = pickExtra(value, CONFIG_KEYS)
  if (extra) config.extra = extra
  if (rawTasks.length > 0) config.rawTasks = rawTasks
  return config
}

/** 文件格式坏了就报错、不降级为空列表：否则下一次保存会把用户的文件整个覆盖掉。 */
export function parseRunConfigFile(text: string): ParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { ok: true, file: { configs: [] } }
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isRecord(data)) return { ok: false, error: '顶层必须是对象' }
  if (data.configs !== undefined && !Array.isArray(data.configs)) return { ok: false, error: 'configs 必须是数组' }
  const configs: RunConfig[] = []
  const rawConfigs: unknown[] = []
  for (const item of (data.configs as unknown[] | undefined) ?? []) {
    const config = parseConfig(item)
    if (config) configs.push(config)
    else rawConfigs.push(item)
  }
  const file: RunConfigFile = { configs }
  const extra = pickExtra(data, new Set(['configs']))
  if (extra) file.extra = extra
  if (rawConfigs.length > 0) file.rawConfigs = rawConfigs
  return { ok: true, file }
}

export function serializeTask(task: RunTask): Record<string, unknown> {
  const out: Record<string, unknown> = { id: task.id }
  if (task.name !== undefined) out.name = task.name
  out.type = task.type
  out.target = task.target
  if (task.cwd) out.cwd = task.cwd
  if (task.env && Object.keys(task.env).length > 0) out.env = task.env
  if (task.os !== undefined) out.os = task.os
  return { ...out, ...task.extra }
}

export function serializeConfig(config: RunConfig): Record<string, unknown> {
  return {
    id: config.id,
    name: config.name,
    // 旧版 CLI 总是写出该字段，保持一致便于 diff。
    restoreWithProjectSession: config.restoreWithProjectSession === true,
    tasks: [...config.tasks.map(serializeTask), ...(config.rawTasks ?? [])],
    ...config.extra,
  }
}

export function serializeRunConfigFile(file: RunConfigFile): string {
  const data = {
    configs: [...file.configs.map(serializeConfig), ...(file.rawConfigs ?? [])],
    ...file.extra,
  }
  return `${JSON.stringify(data, null, 2)}\n`
}

// ---------- 路径 ----------

function separatorOf(root: string): string {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/'
}

export function joinPath(root: string, ...parts: string[]): string {
  const sep = separatorOf(root)
  return [root.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

export function runConfigPaths(root: string): { dir: string; file: string; legacyFile: string } {
  return {
    dir: joinPath(root, '.qingcode'),
    file: joinPath(root, '.qingcode', 'run.json'),
    legacyFile: joinPath(root, '.nestcode', 'run.json'),
  }
}

/** 比较路径：统一分隔符、去尾部斜杠；Windows 盘符路径不区分大小写。 */
export function normalizePath(value: string): string {
  const unified = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[A-Za-z]:/.test(unified) || value.includes('\\') ? unified.toLowerCase() : unified
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

/** 变化路径是否落在 .qingcode / .nestcode 目录（含目录本身）。 */
export function isConfigPath(root: string, changed: string): boolean {
  const target = normalizePath(changed)
  return ['.qingcode', '.nestcode'].some((dir) => {
    const base = normalizePath(joinPath(root, dir))
    return target === base || target.startsWith(`${base}/`)
  })
}

// ---------- 按系统过滤 ----------

export type ResolvedTask =
  | { ok: true; task: RunStartTask }
  | { ok: false; reason: string }

/** 设置了 cwd 时，target 开头的 `cd xxx &&` 是多余的，且在 Windows CMD 下常出错（沿用旧版）。 */
export function stripRedundantCdPrefix(target: string): string {
  return target.replace(/^(?:cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:;|&&|&)\s*)+/i, '').trim()
}

export function resolveTask(task: RunTask, os: RunOs): ResolvedTask {
  const label = task.name || task.target || task.id
  if (typeof task.os === 'string' && task.os !== os) {
    return { ok: false, reason: `「${label}」仅限 ${OS_LABEL[task.os]}` }
  }
  const override = typeof task.os === 'object' ? task.os[os] : undefined
  const type = override?.type ?? task.type
  let target = (override?.target ?? task.target).trim()
  const cwd = (override?.cwd !== undefined ? override.cwd : task.cwd)?.trim()
  const env = task.env || override?.env ? { ...task.env, ...override?.env } : undefined
  if (!target) return { ok: false, reason: `「${label}」未配置 ${OS_LABEL[os]} 下的命令` }
  if (type === 'bat' && os !== 'windows') return { ok: false, reason: `「${label}」是 BAT 任务，不能在 ${OS_LABEL[os]} 上运行` }
  if (type === 'command' && cwd) target = stripRedundantCdPrefix(target) || target
  const resolved: RunStartTask = { type, target }
  if (cwd) resolved.cwd = cwd
  if (env && Object.keys(env).length > 0) resolved.env = env
  return { ok: true, task: resolved }
}

export function configTasksFor(
  config: RunConfig,
  os: RunOs,
): { runnable: Array<{ task: RunTask; start: RunStartTask }>; skipped: Array<{ task: RunTask; reason: string }> } {
  const runnable: Array<{ task: RunTask; start: RunStartTask }> = []
  const skipped: Array<{ task: RunTask; reason: string }> = []
  for (const task of config.tasks) {
    const resolved = resolveTask(task, os)
    if (resolved.ok) runnable.push({ task, start: resolved.task })
    else skipped.push({ task, reason: resolved.reason })
  }
  return { runnable, skipped }
}

export function runKey(configId: string, taskId: string): string {
  return `${configId}/${taskId}`
}

export function taskLabel(config: RunConfig, task: RunTask): string {
  const name = task.name?.trim() || task.target || '任务'
  return config.tasks.length > 1 ? `${config.name} · ${name}` : config.name || name
}

export function taskOverview(config: RunConfig): string {
  if (config.tasks.length === 0) return '无任务'
  return config.tasks
    .map((task) => {
      const name = task.name ? `${task.name}: ` : ''
      const target = task.target || (typeof task.os === 'object' ? Object.values(task.os).find((o) => o?.target)?.target ?? '' : '')
      return `${name}${target}`
    })
    .join(' · ')
}

// ---------- 新建 / 复制 / 删除 ----------

export function newId(): string {
  return globalThis.crypto.randomUUID()
}

export function createTask(partial: Partial<Omit<RunTask, 'id'>> = {}): RunTask {
  return { id: newId(), type: 'command', target: '', ...partial }
}

export function createConfig(existing: RunConfig[], name = '新配置'): RunConfig {
  return { id: newId(), name: uniqueName(existing, name), tasks: [createTask()] }
}

export function uniqueName(existing: RunConfig[], base: string): string {
  const names = new Set(existing.map((config) => config.name))
  if (!names.has(base)) return base
  for (let index = 2; ; index++) {
    const candidate = `${base} ${index}`
    if (!names.has(candidate)) return candidate
  }
}

export function duplicateConfig(existing: RunConfig[], config: RunConfig): RunConfig {
  return {
    ...structuredClone(config),
    id: newId(),
    name: uniqueName(existing, `${config.name} 副本`),
    tasks: config.tasks.map((task) => ({ ...structuredClone(task), id: newId() })),
  }
}

export function upsertConfig(configs: RunConfig[], config: RunConfig): RunConfig[] {
  const index = configs.findIndex((item) => item.id === config.id)
  if (index < 0) return [...configs, config]
  return configs.map((item, i) => (i === index ? config : item))
}

export function removeConfig(configs: RunConfig[], id: string): RunConfig[] {
  return configs.filter((config) => config.id !== id)
}

// ---------- 编辑器草稿 ----------

export type EnvRow = { key: string; value: string }

export type TaskDraft = {
  id: string
  name: string
  type: RunTaskType
  target: string
  cwd: string
  env: EnvRow[]
  /** 'all' 不限系统；否则仅在该系统运行 */
  restriction: RunOs | 'all'
  /** 无法用"系统限制"表达的旧版多系统覆盖，原样保留 */
  overrides?: RunTaskOs
  extra?: Record<string, unknown>
}

export type ConfigDraft = {
  id: string
  name: string
  tasks: TaskDraft[]
  base: RunConfig
}

const envRows = (env: Record<string, string> | undefined): EnvRow[] =>
  Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))

export function taskToDraft(task: RunTask): TaskDraft {
  const draft: TaskDraft = {
    id: task.id,
    name: task.name ?? '',
    type: task.type,
    target: task.target,
    cwd: task.cwd ?? '',
    env: envRows(task.env),
    restriction: 'all',
  }
  if (task.extra) draft.extra = task.extra
  if (typeof task.os === 'string') {
    draft.restriction = task.os
  } else if (task.os) {
    const keys = Object.keys(task.os) as RunOs[]
    const only = keys.length === 1 ? keys[0] : undefined
    const override = only ? task.os[only] : undefined
    const plain = override && Object.keys(override).every((key) => ['type', 'target', 'cwd', 'env'].includes(key))
    // 旧版"仅某系统"就是基础 target 为空、只有一个系统覆盖；这种形态可以无损转成系统限制。
    if (only && override && plain && !task.target) {
      draft.restriction = only
      draft.type = override.type ?? task.type
      draft.target = override.target ?? ''
      draft.cwd = override.cwd ?? task.cwd ?? ''
      draft.env = envRows({ ...task.env, ...override.env })
    } else {
      draft.overrides = task.os
    }
  }
  return draft
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const row of rows) if (row.key.trim()) env[row.key.trim()] = row.value
  return Object.keys(env).length > 0 ? env : undefined
}

export function draftToTask(draft: TaskDraft): RunTask {
  const task: RunTask = { id: draft.id, type: draft.type, target: draft.target.trim() }
  if (draft.name.trim()) task.name = draft.name.trim()
  const cwd = draft.cwd.trim()
  const env = rowsToEnv(draft.env)
  if (draft.restriction === 'all') {
    if (cwd) task.cwd = cwd
    if (env) task.env = env
    if (draft.overrides) task.os = draft.overrides
  } else {
    // 写成旧版能读的覆盖对象，而不是字符串：旧版 CLI 遇到字符串 os 会整份文件解析失败。
    const override: RunTaskOverride = { type: draft.type, target: draft.target.trim() }
    if (cwd) override.cwd = cwd
    if (env) override.env = env
    task.target = ''
    task.os = { [draft.restriction]: override }
  }
  if (draft.extra) task.extra = draft.extra
  return task
}

export function configToDraft(config: RunConfig): ConfigDraft {
  return { id: config.id, name: config.name, tasks: config.tasks.map(taskToDraft), base: config }
}

export function draftToConfig(draft: ConfigDraft): RunConfig {
  return { ...draft.base, id: draft.id, name: draft.name.trim(), tasks: draft.tasks.map(draftToTask) }
}

export function emptyTaskDraft(): TaskDraft {
  return taskToDraft(createTask())
}

/** 返回错误列表；空数组表示可保存。 */
export function validateDraft(draft: ConfigDraft, others: RunConfig[]): string[] {
  const errors: string[] = []
  const name = draft.name.trim()
  if (!name) errors.push('请填写配置名称')
  // 旧版 CLI 按名称定位配置，重名会导致 `qingcode run start <name>` 报歧义。
  else if (others.some((config) => config.id !== draft.id && config.name === name)) errors.push(`已有同名配置「${name}」`)
  if (draft.tasks.length === 0) errors.push('至少需要一个任务')
  draft.tasks.forEach((task, index) => {
    const label = task.name.trim() || `任务 ${index + 1}`
    const overrideTarget = Object.values(task.overrides ?? {}).some((o) => o?.target?.trim())
    if (!task.target.trim() && !overrideTarget) {
      errors.push(`${label}：请填写${task.type === 'command' ? '命令' : '脚本路径'}`)
    }
    if (task.type !== 'command' && /[\r\n]/.test(task.target)) errors.push(`${label}：脚本路径不能换行`)
    if (task.type === 'bat' && task.restriction !== 'all' && task.restriction !== 'windows') {
      errors.push(`${label}：BAT 任务只能在 Windows 上运行`)
    }
    const keys = new Set<string>()
    for (const row of task.env) {
      const key = row.key.trim()
      if (!key) {
        if (row.value) errors.push(`${label}：环境变量名不能为空`)
        continue
      }
      if (key.includes('=') || /\s/.test(key)) errors.push(`${label}：环境变量名「${key}」无效`)
      if (keys.has(key)) errors.push(`${label}：环境变量「${key}」重复`)
      keys.add(key)
    }
  })
  return errors
}

// ---------- 自动发现（只生成建议，用户确认后才写入） ----------

export type DiscoveredTask = {
  key: string
  name: string
  /** 来源文件，相对项目根 */
  source: string
  /** 原始脚本内容或说明，供用户确认 */
  detail: string
  task: Omit<RunTask, 'id'>
}

export type DiscoveryWarning = { source: string; message: string }

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const MANAGER_LOCKS: Record<string, PackageManager> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
}

export function detectPackageManager(fileNames: string[], manifest: Record<string, unknown> | null): PackageManager | null {
  if (typeof manifest?.packageManager === 'string') {
    const match = /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)
    if (match) return match[1] as PackageManager
  }
  for (const name of fileNames) {
    const manager = MANAGER_LOCKS[name]
    if (manager) return manager
  }
  return null
}

export function discoverPackageScripts(
  text: string,
  options: { cwd: string; fileNames: string[]; inherited?: PackageManager | null },
): { tasks: DiscoveredTask[]; warnings: DiscoveryWarning[]; manager: PackageManager } {
  const source = options.cwd ? `${options.cwd}/package.json` : 'package.json'
  const warnings: DiscoveryWarning[] = []
  let manifest: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (isRecord(parsed)) manifest = parsed
    else warnings.push({ source, message: 'package.json 必须是 JSON 对象' })
  } catch {
    warnings.push({ source, message: 'package.json 解析失败' })
  }
  const manager = detectPackageManager(options.fileNames, manifest) ?? options.inherited ?? 'npm'
  const tasks: DiscoveredTask[] = []
  const scripts = manifest?.scripts
  if (!isRecord(scripts)) return { tasks, warnings, manager }
  const entries = Object.entries(scripts)
  if (entries.length > 100) warnings.push({ source, message: '脚本过多，只取前 100 个' })
  for (const [name, script] of entries.slice(0, 100)) {
    if (typeof script !== 'string' || !script.trim()) continue
    // 只接受可安全拼进命令行的脚本名，避免替用户猜引号。
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(name)) {
      warnings.push({ source, message: `脚本名无法安全生成命令：${name}` })
      continue
    }
    tasks.push({
      key: `${source}:${name}`,
      name: options.cwd ? `${options.cwd}: ${name}` : name,
      source,
      detail: script,
      task: { name, type: 'command', target: `${manager} run ${name}`, ...(options.cwd ? { cwd: options.cwd } : {}) },
    })
  }
  return { tasks, warnings, manager }
}

export function discoverMakeTargets(text: string, source = 'Makefile'): DiscoveredTask[] {
  const seen = new Set<string>()
  const tasks: DiscoveredTask[] = []
  for (const line of text.split(/\r?\n/)) {
    // `name:` 但不是 `name := value`、`name::=`；跳过 .PHONY 等特殊目标与模式规则。
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9_.-]*)*)\s*:(?![:=])/.exec(line)
    if (!match) continue
    for (const name of match[1]!.split(/\s+/)) {
      if (seen.has(name) || name.includes('%')) continue
      seen.add(name)
      tasks.push({
        key: `${source}:${name}`,
        name: `make ${name}`,
        source,
        detail: line.trim(),
        task: { name, type: 'command', target: `make ${name}` },
      })
      if (tasks.length >= 50) return tasks
    }
  }
  return tasks
}

export function discoverCargo(text: string, source = 'Cargo.toml'): DiscoveredTask[] {
  const hasPackage = /^\s*\[package\]/m.test(text)
  const hasWorkspace = /^\s*\[workspace\]/m.test(text)
  if (!hasPackage && !hasWorkspace) return []
  const tasks: DiscoveredTask[] = []
  if (hasPackage || /^\s*\[\[bin\]\]/m.test(text)) {
    tasks.push({ key: `${source}:run`, name: 'cargo run', source, detail: 'cargo run', task: { name: 'run', type: 'command', target: 'cargo run' } })
  }
  tasks.push({ key: `${source}:test`, name: 'cargo test', source, detail: 'cargo test', task: { name: 'test', type: 'command', target: 'cargo test' } })
  return tasks
}

/** 从 pyproject.toml 取 `[project.scripts]` / `[tool.poetry.scripts]` 的键。 */
export function pyprojectScripts(text: string): string[] {
  const names: string[] = []
  let inScripts = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inScripts = line === '[project.scripts]' || line === '[tool.poetry.scripts]'
      continue
    }
    if (!inScripts) continue
    const match = /^["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?\s*=/.exec(line)
    if (match && !names.includes(match[1]!)) names.push(match[1]!)
  }
  return names
}

export function discoverPython(input: {
  fileNames: string[]
  pyproject: string | null
  os: RunOs
}): DiscoveredTask[] {
  const python = input.os === 'windows' ? 'python' : 'python3'
  const has = (name: string): boolean => input.fileNames.includes(name)
  const runner = has('uv.lock') ? 'uv run ' : input.pyproject && /^\s*\[tool\.poetry\]/m.test(input.pyproject) ? 'poetry run ' : ''
  const tasks: DiscoveredTask[] = []
  const add = (key: string, name: string, source: string, target: string): void => {
    tasks.push({ key: `${source}:${key}`, name, source, detail: target, task: { name: key, type: 'command', target } })
  }
  // uv / poetry 管理的虚拟环境里应调用环境内的 python。
  const py = runner ? `${runner}python` : python
  if (has('manage.py')) {
    add('runserver', 'Django runserver', 'manage.py', `${py} manage.py runserver`)
    add('test', 'Django test', 'manage.py', `${py} manage.py test`)
  }
  if (input.pyproject !== null) {
    for (const name of pyprojectScripts(input.pyproject)) add(name, name, 'pyproject.toml', `${runner}${name}`)
    if (/^\s*\[tool\.pytest/m.test(input.pyproject) || has('pytest.ini') || has('tests')) {
      add('pytest', 'pytest', 'pyproject.toml', `${py} -m pytest`)
    }
  }
  return tasks
}

function taskSignature(task: Pick<RunTask, 'type' | 'target' | 'cwd'>): string {
  const cwd = (task.cwd ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, '')
  return JSON.stringify([task.type, task.target.trim(), cwd])
}

export function isDiscoveredImported(task: DiscoveredTask, configs: RunConfig[]): boolean {
  const signature = taskSignature(task.task)
  return configs.some((config) => config.tasks.some((existing) => taskSignature(existing) === signature))
}

/** 保存前再按最新配置去重；combined 时合并成一个多任务配置。 */
export function importDiscovered(configs: RunConfig[], tasks: DiscoveredTask[], combined: boolean): RunConfig[] {
  const fresh = tasks.filter((task) => !isDiscoveredImported(task, configs))
  if (fresh.length === 0) return configs
  const toTask = (task: DiscoveredTask): RunTask => ({ ...task.task, id: newId() })
  if (combined) {
    return [
      ...configs,
      { id: newId(), name: uniqueName(configs, fresh.map((task) => task.name).join(' + ')), tasks: fresh.map(toTask) },
    ]
  }
  const next = [...configs]
  for (const task of fresh) next.push({ id: newId(), name: uniqueName(next, task.name), tasks: [toTask(task)] })
  return next
}
