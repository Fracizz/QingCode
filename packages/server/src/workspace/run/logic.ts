import path from 'node:path'
import type { RunOs, RunStartParams, RunStartTask, RunTaskOverride, RunTaskType } from './types'
import { WorkspaceError } from '../registry'

// 运行任务的纯逻辑：参数校验、按系统合并覆盖、命令行构造与转义。IO（spawn、查 PATH）在 manager.ts。

export const RUN_TASK_TYPES: readonly RunTaskType[] = ['command', 'ps1', 'bat', 'sh', 'script']
export const RUN_OS_LIST: readonly RunOs[] = ['windows', 'linux', 'macos']

export function platformToOs(platform: NodeJS.Platform): RunOs {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEnv(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new WorkspaceError('params', `${where} 必须是对象`)
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new WorkspaceError('params', `${where}.${key} 必须是字符串`)
    // 空键或含 = 的键在各平台都无法作为环境变量名。
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new WorkspaceError('params', `${where} 含无效变量名`)
    }
    env[key] = item
  }
  return env
}

function parseType(value: unknown, where: string): RunTaskType {
  if (value === undefined || value === null) return 'command'
  if (typeof value !== 'string' || !RUN_TASK_TYPES.includes(value as RunTaskType)) {
    // i18n-ignore: 按实际取值在词典登记整句
    throw new WorkspaceError('params', `${where} 只能是 ${RUN_TASK_TYPES.join('、')}`)
  }
  return value as RunTaskType
}

function parseOverrides(value: unknown): Partial<Record<RunOs, RunTaskOverride>> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new WorkspaceError('params', 'task.os 必须是对象（windows、linux、macos）')
  const result: Partial<Record<RunOs, RunTaskOverride>> = {}
  for (const [os, fields] of Object.entries(value)) {
    if (!RUN_OS_LIST.includes(os as RunOs)) throw new WorkspaceError('params', `不支持的 task.os：${os}`)
    if (!isRecord(fields)) throw new WorkspaceError('params', `task.os.${os} 必须是对象`)
    const override: RunTaskOverride = {}
    if (fields.type !== undefined) override.type = parseType(fields.type, `task.os.${os}.type`)
    for (const key of ['target', 'cwd'] as const) {
      const field = fields[key]
      if (field === undefined) continue
      if (typeof field !== 'string') throw new WorkspaceError('params', `task.os.${os}.${key} 必须是字符串`)
      override[key] = field.trim()
    }
    const env = parseEnv(fields.env, `task.os.${os}.env`)
    if (env) override.env = env
    result[os as RunOs] = override
  }
  return result
}

export function parseStartParams(p: Record<string, unknown>): RunStartParams {
  const cwd = p.cwd
  if (typeof cwd !== 'string' || !cwd) throw new WorkspaceError('params', 'cwd 必须是非空字符串')
  if (!path.isAbsolute(cwd)) throw new WorkspaceError('params', 'cwd 必须是绝对路径')
  if (!isRecord(p.task)) throw new WorkspaceError('params', 'task 必须是对象')
  const raw = p.task
  if (raw.target !== undefined && typeof raw.target !== 'string') {
    throw new WorkspaceError('params', 'task.target 必须是字符串')
  }
  if (raw.cwd !== undefined && raw.cwd !== null && typeof raw.cwd !== 'string') {
    throw new WorkspaceError('params', 'task.cwd 必须是字符串')
  }
  const task: RunStartTask = {
    type: parseType(raw.type, 'task.type'),
    target: typeof raw.target === 'string' ? raw.target.trim() : '',
  }
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) task.cwd = raw.cwd.trim()
  const env = parseEnv(raw.env, 'task.env')
  if (env) task.env = env
  const os = parseOverrides(raw.os)
  if (os) task.os = os
  const params: RunStartParams = { cwd, task }
  if (p.label !== undefined && p.label !== null) {
    if (typeof p.label !== 'string') throw new WorkspaceError('params', 'label 必须是字符串')
    if (p.label.trim()) params.label = p.label.trim().slice(0, 200)
  }
  if (p.key !== undefined && p.key !== null) {
    if (typeof p.key !== 'string') throw new WorkspaceError('params', 'key 必须是字符串')
    if (p.key) params.key = p.key.slice(0, 500)
  }
  return params
}

export type ResolvedTask = {
  type: RunTaskType
  target: string
  cwd?: string
  env?: Record<string, string>
}

/** 与旧版 resolveRunTask 一致：覆盖字段整体替换，env 合并；BAT 只能在 Windows 上跑。 */
export function resolveTaskForOs(task: RunStartTask, os: RunOs): ResolvedTask {
  const override = task.os?.[os]
  const type = override?.type ?? task.type
  const target = (override?.target ?? task.target).trim()
  const cwd = override?.cwd !== undefined ? override.cwd : task.cwd
  const env = task.env || override?.env ? { ...task.env, ...override?.env } : undefined
  if (!target) throw new WorkspaceError('params', `任务未配置 ${os} 下的命令或脚本`)
  if (type === 'bat' && os !== 'windows') throw new WorkspaceError('params', `BAT 任务不能在 ${os} 上运行`)
  const resolved: ResolvedTask = { type, target }
  if (cwd && cwd.trim()) resolved.cwd = cwd.trim()
  if (env) resolved.env = env
  return resolved
}

/** task.cwd 相对项目根；绝对路径原样使用。 */
export function resolveWorkdir(root: string, taskCwd: string | undefined, pathApi: typeof path = path): string {
  if (!taskCwd) return root
  return pathApi.resolve(root, taskCwd)
}

/** Windows 环境变量名不区分大小写：覆盖时先删掉同名不同大小写的旧键，避免 Path/PATH 并存。 */
export function mergeEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> | undefined,
  windows: boolean,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value
  }
  const apply = (key: string, value: string): void => {
    if (windows) {
      const lower = key.toLowerCase()
      for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toLowerCase() === lower) delete env[existing]
      }
    }
    env[key] = value
  }
  // 交给前端的输出保留 ANSI，多数 CLI 在管道下需要 FORCE_COLOR 才输出颜色。
  apply('FORCE_COLOR', '1')
  for (const [key, value] of Object.entries(extra ?? {})) apply(key, value)
  return env
}

export type ScriptKind = 'ps1' | 'bat' | 'sh' | 'py' | 'node' | 'other'

export function scriptKind(target: string): ScriptKind {
  const name = target.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'ps1':
      return 'ps1'
    case 'bat':
    case 'cmd':
      return 'bat'
    case 'sh':
    case 'bash':
      return 'sh'
    case 'py':
      return 'py'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'node'
    default:
      return 'other'
  }
}

/** POSIX 单引号转义：'a'"'"'b' */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** 仅用于展示：按 Windows/POSIX 习惯给含空格的参数加引号。 */
export function displayCommand(file: string, args: readonly string[], verbatim: boolean): string {
  const quote = (value: string): string => {
    if (verbatim) return value
    if (value === '') return '""'
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
  }
  return [quote(file), ...args.map(quote)].join(' ')
}

export type SpawnPlan = {
  file: string
  args: string[]
  /** Windows 下交给 cmd.exe 的命令行不能被 Node 再加引号 */
  windowsVerbatimArguments: boolean
  command: string
}

export type CommandTools = {
  /** 查 PATH，找不到返回 null；Windows 自动补 PATHEXT */
  which(name: string): string | null
  comspec?: string
}

// 传整句而非名词片段，展示端才能按整句翻译。
function assertSingleLine(value: string, message: string): void {
  if (/[\r\n\0]/.test(value)) throw new WorkspaceError('params', message)
}

function windowsPath(target: string): string {
  // 兼容 SFTP 风格 `/D:/x` 与正斜杠写法。
  const native = /^\/[A-Za-z]:[\\/]/.test(target) ? target.slice(1) : target
  return native.replace(/\//g, '\\')
}

/** 设置了 NoDefaultCurrentDirectoryInExePath 时 cmd 不在当前目录找程序，相对路径须显式带 `.\`。 */
function windowsRelative(file: string): string {
  if (/^[A-Za-z]:\\/.test(file) || file.startsWith('\\\\') || /^\.\.?\\/.test(file)) return file
  return `.\\${file}`
}

function plan(file: string, args: string[], verbatim = false): SpawnPlan {
  return { file, args, windowsVerbatimArguments: verbatim, command: displayCommand(file, args, verbatim) }
}

function cmdLine(tools: CommandTools, line: string): SpawnPlan {
  // /s + 外层引号：cmd 去掉最外一层引号后原样解析，与 Node shell:true 的做法一致。
  return plan(tools.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], true)
}

function powershell(tools: CommandTools, scriptPath: string): SpawnPlan {
  const exe = tools.which('pwsh') ?? tools.which('powershell')
  if (!exe) throw new WorkspaceError('not_found', '未找到 pwsh 或 powershell')
  return plan(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath])
}

function windowsPlan(type: RunTaskType, target: string, tools: CommandTools): SpawnPlan {
  if (type === 'command') {
    assertSingleLine(target, '命令不能包含换行或空字符')
    return cmdLine(tools, target)
  }
  assertSingleLine(target, '脚本路径不能包含换行或空字符')
  const file = windowsPath(target)
  const kind: ScriptKind = type === 'script' ? scriptKind(file) : type
  if (kind !== 'ps1' && file.includes('"')) throw new WorkspaceError('params', '脚本路径不能包含双引号')
  switch (kind) {
    case 'ps1':
      return powershell(tools, file)
    case 'bat':
    case 'other':
      // 未知扩展名交给 cmd 按文件关联执行，与旧版一致。
      return cmdLine(tools, `"${windowsRelative(file)}"`)
    case 'sh': {
      // System32\bash.exe 是 WSL 启动器，路径语义不同，不能当 Git Bash 用。
      const bash = tools.which('sh') ?? nonWslBash(tools.which('bash'))
      if (!bash) throw new WorkspaceError('not_found', '未找到 sh 或 bash（可安装 Git for Windows）')
      return plan(bash, [file])
    }
    case 'py':
      return plan(tools.which('python') ?? tools.which('py') ?? 'python', [file])
    case 'node':
      return plan(tools.which('node') ?? 'node', [file])
  }
}

function nonWslBash(found: string | null): string | null {
  if (!found) return null
  return /\\windows\\system32\\/i.test(found) ? null : found
}

function posixPlan(type: RunTaskType, target: string, tools: CommandTools): SpawnPlan {
  if (type === 'command') return plan('sh', ['-lc', target])
  assertSingleLine(target, '脚本路径不能包含换行或空字符')
  const kind: ScriptKind = type === 'script' ? scriptKind(target) : type
  switch (kind) {
    case 'bat':
      throw new WorkspaceError('params', 'BAT/CMD 脚本只能在 Windows 上运行')
    case 'ps1': {
      const pwsh = tools.which('pwsh')
      if (!pwsh) throw new WorkspaceError('not_found', '未找到 pwsh，无法运行 PowerShell 脚本')
      return plan(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target])
    }
    case 'sh':
      return plan('sh', [target])
    case 'py':
      return plan(tools.which('python3') ?? tools.which('python') ?? 'python3', [target])
    case 'node':
      return plan(tools.which('node') ?? 'node', [target])
    case 'other': {
      // 有执行权限直接执行（尊重 shebang），否则当 sh 脚本。
      const q = shellQuote(target.includes('/') ? target : `./${target}`)
      return plan('sh', ['-lc', `if [ -x ${q} ]; then exec ${q}; else exec /bin/sh ${q}; fi`])
    }
  }
}

export function buildSpawnPlan(task: ResolvedTask, os: RunOs, tools: CommandTools): SpawnPlan {
  if (!task.target.trim()) throw new WorkspaceError('params', '命令或脚本路径不能为空')
  return os === 'windows' ? windowsPlan(task.type, task.target, tools) : posixPlan(task.type, task.target, tools)
}

/** PATH 查找（纯函数，exists 注入便于测试）。 */
export function findInPath(
  name: string,
  env: Record<string, string | undefined>,
  windows: boolean,
  exists: (file: string) => boolean,
): string | null {
  const pathApi = windows ? path.win32 : path.posix
  const pathKey = Object.keys(env).find((key) => (windows ? key.toLowerCase() === 'path' : key === 'PATH'))
  const dirs = (pathKey ? env[pathKey] ?? '' : '').split(windows ? ';' : ':').filter(Boolean)
  const extKey = Object.keys(env).find((key) => key.toLowerCase() === 'pathext')
  const exts = windows
    ? (extKey ? env[extKey] ?? '' : '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const hasExt = windows && /\.[A-Za-z0-9]+$/.test(name)
  for (const dir of dirs) {
    const clean = dir.replace(/^"(.*)"$/, '$1')
    for (const ext of hasExt ? [''] : exts) {
      const file = pathApi.join(clean, name + ext.toLowerCase())
      if (exists(file)) return file
    }
  }
  return null
}
