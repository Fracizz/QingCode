import JSON5 from 'json5'
import { safeInvoke } from './tauri'
import type { Project } from '../types'

export type ProjectCustomSettings = Record<string, unknown>

/** Entry in global `qingcode.projects` (default-settings.json / JSON5 only). */
export interface SettingsProjectEntry {
  /** Display name; defaults to the folder name when omitted. */
  name?: string
  /** Absolute project directory path. */
  path: string
  /** When true, hide from the title-bar project chips. */
  hidden?: boolean
  /** Optional default shell hint. */
  defaultShell?: string
}

/** QingCode settings — VS Code–style keys plus free-form `custom`. */
export interface SettingsFile {
  version: 1
  custom: ProjectCustomSettings
  [key: string]: unknown
}

/** @deprecated Prefer SettingsFile */
export type ProjectSettingsFile = SettingsFile

export type SettingsScope = 'global' | 'project'

export const PROJECT_SETTINGS_RELATIVE_PATH = '.qingcode/project-settings.json'
export const GLOBAL_SETTINGS_DISPLAY_PATH = '全局设置 / default-settings.json'

export const PROJECTS_KEY = 'qingcode.projects'
export const PROJECTS_SYNC_ON_STARTUP_KEY = 'qingcode.projects.syncOnStartup'

function buildSharedDefaults(): SettingsFile {
  return {
    version: 1,
    'editor.fontSize': 14,
    'editor.tabSize': 4,
    'editor.insertSpaces': true,
    'editor.detectIndentation': true,
    'editor.wordWrap': 'off',
    'editor.lineNumbers': 'on',
    'editor.renderWhitespace': 'selection',
    'editor.minimap.enabled': false,
    'editor.formatOnSave': false,
    'editor.formatOnPaste': false,
    'editor.linkedEditing': false,
    'editor.bracketPairColorization.enabled': true,
    'editor.guides.bracketPairs': true,
    'files.autoSave': 'off',
    'files.autoSaveDelay': 1000,
    'files.eol': 'auto',
    'files.encoding': 'utf8',
    'files.trimTrailingWhitespace': false,
    'files.insertFinalNewline': false,
    'files.exclude': {
      '**/.git': true,
      '**/.svn': true,
      '**/.hg': true,
      '**/CVS': true,
      '**/.DS_Store': true,
      '**/Thumbs.db': true,
      '**/node_modules': true,
      '**/dist': true,
      '**/build': true,
      '**/target': true,
      '**/.qingcode': false,
    },
    'search.exclude': {
      '**/node_modules': true,
      '**/bower_components': true,
      '**/dist': true,
      '**/build': true,
      '**/target': true,
      '**/*.code-search': true,
    },
    'search.followSymlinks': true,
    'search.useIgnoreFiles': true,
    'explorer.excludeGitIgnore': true,
    'terminal.integrated.scrollback': 5000,
    'terminal.integrated.cursorBlinking': true,
    custom: {},
  }
}

/** Global default-settings defaults (includes machine-wide project list). */
export const DEFAULT_GLOBAL_SETTINGS: SettingsFile = {
  ...buildSharedDefaults(),
  [PROJECTS_SYNC_ON_STARTUP_KEY]: true,
  [PROJECTS_KEY]: [] as SettingsProjectEntry[],
}

/** Workspace `.qingcode/project-settings.json` defaults (no project list — global-only). */
export const DEFAULT_PROJECT_SETTINGS: SettingsFile = buildSharedDefaults()

/** @deprecated Prefer DEFAULT_GLOBAL_SETTINGS */
export const DEFAULT_SETTINGS = DEFAULT_GLOBAL_SETTINGS

const SHARED_SETTINGS_BODY = `
  // ============================== 编辑器 ==============================
  // 编辑器字号（像素）
  "editor.fontSize": 14,
  // Tab 宽度（空格数）。insertSpaces 为 true 时按空格缩进
  "editor.tabSize": 4,
  // true = 按空格缩进；false = 插入 Tab 字符
  "editor.insertSpaces": true,
  // 打开文件时是否根据内容自动推断缩进风格
  "editor.detectIndentation": true,
  // 自动换行：off | on | wordWrapColumn | bounded
  "editor.wordWrap": "off",
  // 行号显示：on | off | relative | interval
  "editor.lineNumbers": "on",
  // 空白字符渲染：none | boundary | selection | trailing | all
  "editor.renderWhitespace": "selection",
  // 是否显示小地图（当前版本可能尚未全部接线，可预留）
  "editor.minimap.enabled": false,
  // 保存时是否自动格式化
  "editor.formatOnSave": false,
  // 粘贴时是否自动格式化
  "editor.formatOnPaste": false,
  // 是否启用链接编辑（如同时改标签名）
  "editor.linkedEditing": false,
  // 括号对着色
  "editor.bracketPairColorization.enabled": true,
  // 括号对参考线
  "editor.guides.bracketPairs": true,

  // ============================== 文件 ==============================
  // 自动保存：off | afterDelay | onFocusChange | onWindowChange
  "files.autoSave": "off",
  // afterDelay 模式下的延迟（毫秒）
  "files.autoSaveDelay": 1000,
  // 换行符：auto | LF | CRLF
  "files.eol": "auto",
  // 默认文件编码
  "files.encoding": "utf8",
  // 保存时去掉行尾空格
  "files.trimTrailingWhitespace": false,
  // 保存时确保文件以空行结尾
  "files.insertFinalNewline": false,
  // 资源管理器中隐藏的文件/目录（true = 隐藏）
  "files.exclude": {
    "**/.git": true,
    "**/.svn": true,
    "**/.hg": true,
    "**/CVS": true,
    "**/.DS_Store": true,
    "**/Thumbs.db": true,
    "**/node_modules": true,
    "**/dist": true,
    "**/build": true,
    "**/target": true,
    // QingCode 项目配置目录默认显示，便于编辑
    "**/.qingcode": false,
  },

  // ============================== 搜索 ==============================
  // 全文搜索时排除的路径
  "search.exclude": {
    "**/node_modules": true,
    "**/bower_components": true,
    "**/dist": true,
    "**/build": true,
    "**/target": true,
    "**/*.code-search": true,
  },
  // 搜索是否跟随符号链接
  "search.followSymlinks": true,
  // 是否遵守 .gitignore 等忽略规则
  "search.useIgnoreFiles": true,
  // 资源管理器是否按 .gitignore 隐藏条目
  "explorer.excludeGitIgnore": true,

  // ============================== 终端 ==============================
  // 终端回滚缓冲行数
  "terminal.integrated.scrollback": 5000,
  // 终端光标是否闪烁
  "terminal.integrated.cursorBlinking": true,
`

/**
 * Global default-settings.json template (JSON5 with detailed comments).
 * Includes the machine-wide project list — not for workspace settings.
 */
export const DEFAULT_GLOBAL_SETTINGS_TEXT = `{
  // =============================================================================
  // QingCode 全局设置 default-settings.json（JSON5）
  // - 支持 // 与 /* */ 注释、尾逗号、无引号键名
  // - 本文件为「本机全局」配置，对所有项目生效
  // - 工作区专用配置请写各仓库：.qingcode/project-settings.json
  // - 改完后 Ctrl+S 保存；部分项需重启或重开文件后生效
  // =============================================================================
  version: 1,
${SHARED_SETTINGS_BODY}
  // ============================== 全局项目列表 ==============================
  // 仅 default-settings.json 有效；不要写进工作区 project-settings.json
  //
  // qingcode.projects.syncOnStartup
  //   true  = 启动时把下方路径同步进应用项目库
  //   false = 不同步（仍可在项目管理界面手动添加）
  //   已存在的 path：更新 name / hidden / defaultShell，不会删除库里其它项目
  //   无效或不存在的 path：跳过并忽略
  "qingcode.projects.syncOnStartup": true,
  //
  // qingcode.projects：本机项目清单（可复制到其它机器做引导）
  //   name         显示名，可省略（默认用文件夹名）
  //   path         项目根目录绝对路径（必填）
  //   hidden       true 时不在顶栏项目芯片中显示
  //   defaultShell 可选，默认终端/shell 提示
  "qingcode.projects": [
    // {
    //   name: "示例项目",
    //   path: "D:/Work/example",
    //   hidden: false,
    //   // defaultShell: "powershell",
    // },
  ],

  // ============================== 自定义扩展 ==============================
  // 自由键值，供后续功能读取；请勿删除整个 custom 对象
  custom: {
    // apiBaseUrl: "http://localhost:3000",
  },
}
`

/** Workspace project-settings.json template (JSON5 with detailed comments; no project list). */
export const DEFAULT_PROJECT_SETTINGS_TEXT = `{
  // =============================================================================
  // QingCode 工作区设置 project-settings.json（JSON5）
  // - 仅作用于当前项目；同名键会覆盖全局 default-settings.json
  // - 全局项目列表请写在 default-settings.json（qingcode.projects）
  // =============================================================================
  version: 1,
${SHARED_SETTINGS_BODY}
  // ============================== 自定义扩展 ==============================
  custom: {
    // apiBaseUrl: "http://localhost:3000",
  },
}
`

/** @deprecated Prefer DEFAULT_GLOBAL_SETTINGS_TEXT */
export const DEFAULT_SETTINGS_TEXT = DEFAULT_GLOBAL_SETTINGS_TEXT

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function projectConfigDir(project: Project): string {
  const separator = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${project.path}${separator}.qingcode`
}

export function projectSettingsPath(project: Project): string {
  const separator = project.path.includes('\\') && !project.path.includes('/') ? '\\' : '/'
  return `${projectConfigDir(project)}${separator}project-settings.json`
}

export function isSettingsJsonPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return (
    normalized.endsWith('/default-settings.json') ||
    normalized.endsWith('/.qingcode/project-settings.json')
  )
}

export function isGlobalSettingsPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.endsWith('/default-settings.json')
}

export function defaultSettingsFor(scope: SettingsScope): SettingsFile {
  return structuredClone(scope === 'global' ? DEFAULT_GLOBAL_SETTINGS : DEFAULT_PROJECT_SETTINGS)
}

export function defaultSettingsTextFor(scope: SettingsScope): string {
  return withTrailingNewline(
    scope === 'global' ? DEFAULT_GLOBAL_SETTINGS_TEXT : DEFAULT_PROJECT_SETTINGS_TEXT,
  )
}

/** Strip global-only keys that must not live in workspace settings. */
export function stripGlobalOnlyKeys(settings: SettingsFile): SettingsFile {
  const next = { ...settings }
  delete next[PROJECTS_KEY]
  delete next[PROJECTS_SYNC_ON_STARTUP_KEY]
  return next
}

/** Parse JSON or JSON5 text into a settings object. */
export function parseSettingsText(text: string, scope: SettingsScope = 'global'): SettingsFile {
  try {
    return parseSettings(JSON5.parse(text) as unknown, scope)
  } catch {
    return defaultSettingsFor(scope)
  }
}

export function formatSettings(
  settings: SettingsFile = DEFAULT_GLOBAL_SETTINGS,
  scope: SettingsScope = 'global',
): string {
  const normalized = scope === 'project' ? stripGlobalOnlyKeys(settings) : settings
  if (settingsAreDefaultShape(normalized, defaultSettingsFor(scope))) {
    return defaultSettingsTextFor(scope)
  }
  return `${JSON5.stringify(normalized, null, 2)}\n`
}

function settingsAreDefaultShape(settings: SettingsFile, defaults: SettingsFile): boolean {
  try {
    return JSON.stringify(settings) === JSON.stringify(defaults)
  } catch {
    return false
  }
}

export function parseSettings(input: unknown, scope: SettingsScope = 'global'): SettingsFile {
  if (!isRecord(input)) return defaultSettingsFor(scope)
  const custom = isRecord(input.custom) ? input.custom : {}
  const next: SettingsFile = { version: 1, custom }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'version' || key === 'custom') continue
    if (scope === 'project' && (key === PROJECTS_KEY || key === PROJECTS_SYNC_ON_STARTUP_KEY)) {
      continue
    }
    next[key] = value
  }
  if (scope === 'global') {
    if (next[PROJECTS_KEY] === undefined) next[PROJECTS_KEY] = []
    if (next[PROJECTS_SYNC_ON_STARTUP_KEY] === undefined) {
      next[PROJECTS_SYNC_ON_STARTUP_KEY] = true
    }
  }
  return next
}

/** @deprecated Prefer parseSettings */
export function parseProjectSettings(input: unknown): SettingsFile {
  return parseSettings(input, 'project')
}

export function validateSettings(input: unknown): string | null {
  if (!isRecord(input)) return '设置必须是 JSON 对象'
  if (input.version !== 1) return '设置版本必须为 1'
  if (input.custom !== undefined && !isRecord(input.custom)) return 'custom 必须是 JSON 对象'
  if (input[PROJECTS_KEY] !== undefined && !Array.isArray(input[PROJECTS_KEY])) {
    return 'qingcode.projects 必须是数组'
  }
  return null
}

/** @deprecated Prefer validateSettings */
export function validateProjectSettings(input: unknown): string | null {
  return validateSettings(input)
}

export function readProjectEntries(settings: SettingsFile): SettingsProjectEntry[] {
  const raw = settings[PROJECTS_KEY]
  if (!Array.isArray(raw)) return []
  const out: SettingsProjectEntry[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.path !== 'string' || !item.path.trim()) continue
    out.push({
      path: item.path.trim(),
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
      hidden: item.hidden === true,
      defaultShell:
        typeof item.defaultShell === 'string' && item.defaultShell.trim()
          ? item.defaultShell.trim()
          : undefined,
    })
  }
  return out
}

export function shouldSyncProjectsOnStartup(settings: SettingsFile): boolean {
  return settings[PROJECTS_SYNC_ON_STARTUP_KEY] !== false
}

export async function resolveGlobalSettingsPath(): Promise<string> {
  return safeInvoke<string>('读取全局设置路径', 'default_settings_path')
}

export async function resolveProjectSettingsPath(project: Project): Promise<string> {
  return projectSettingsPath(project)
}

export async function loadSettingsFromPath(
  path: string,
  scope?: SettingsScope,
): Promise<SettingsFile> {
  const resolvedScope = scope ?? (isGlobalSettingsPath(path) ? 'global' : 'project')
  try {
    const raw = await safeInvoke<string>('读取设置', 'read_file', { path })
    return parseSettingsText(raw, resolvedScope)
  } catch {
    return defaultSettingsFor(resolvedScope)
  }
}

export async function settingsFileExists(path: string): Promise<boolean> {
  try {
    await safeInvoke<string>('读取设置', 'read_file', { path })
    return true
  } catch {
    return false
  }
}

/** True when the on-disk text already contains JSON5 line/block comments. */
export function settingsTextHasComments(text: string): boolean {
  return /\/\/|\/\*/.test(text)
}

async function writeCommentedTemplate(path: string, scope: SettingsScope): Promise<SettingsFile> {
  await safeInvoke('保存设置', 'write_file', {
    path,
    content: defaultSettingsTextFor(scope),
  })
  return defaultSettingsFor(scope)
}

/**
 * Ensure the settings file exists on disk.
 * - If missing or `writeTemplate`: write the commented JSON5 template for `scope`.
 * - If `upgradeComments` (default true) and the file has no `//` comments: rewrite
 *   the detailed template when content is still default-shaped (or global file is
 *   missing project-list keys from an older bare dump).
 */
export async function ensureSettingsFile(
  path: string,
  options?: {
    scope?: SettingsScope
    writeTemplate?: boolean
    upgradeComments?: boolean
    seed?: SettingsFile
  },
): Promise<SettingsFile> {
  const scope = options?.scope ?? (isGlobalSettingsPath(path) ? 'global' : 'project')
  const upgradeComments = options?.upgradeComments !== false
  const exists = await settingsFileExists(path)

  if (options?.seed) {
    await saveSettingsToPath(path, options.seed, scope)
    return parseSettings(options.seed, scope)
  }

  if (!exists || options?.writeTemplate) {
    return writeCommentedTemplate(path, scope)
  }

  try {
    const raw = await safeInvoke<string>('读取设置', 'read_file', { path })
    if (upgradeComments && !settingsTextHasComments(raw)) {
      const parsed = parseSettingsText(raw, scope)
      const defaults = defaultSettingsFor(scope)
      const nearDefault =
        settingsAreDefaultShape(parsed, defaults) ||
        (scope === 'global' &&
          settingsAreDefaultShape(
            {
              ...parsed,
              [PROJECTS_KEY]: parsed[PROJECTS_KEY] ?? [],
              [PROJECTS_SYNC_ON_STARTUP_KEY]:
                parsed[PROJECTS_SYNC_ON_STARTUP_KEY] ?? true,
            },
            defaults,
          ))
      // Older bare dumps omitted qingcode.projects*; treat as upgradable defaults.
      const legacyBareGlobal =
        scope === 'global' &&
        parsed[PROJECTS_KEY] === undefined &&
        Object.keys(parsed.custom ?? {}).length === 0

      if (nearDefault || legacyBareGlobal) {
        return writeCommentedTemplate(path, scope)
      }
    }
    return parseSettingsText(raw, scope)
  } catch {
    return writeCommentedTemplate(path, scope)
  }
}

export async function saveSettingsToPath(
  path: string,
  settings: SettingsFile,
  scope?: SettingsScope,
): Promise<void> {
  const resolvedScope = scope ?? (isGlobalSettingsPath(path) ? 'global' : 'project')
  await safeInvoke('保存设置', 'write_file', {
    path,
    content: formatSettings(settings, resolvedScope),
  })
}

export async function loadGlobalSettings(): Promise<SettingsFile> {
  const path = await resolveGlobalSettingsPath()
  return loadSettingsFromPath(path, 'global')
}

export async function saveGlobalSettings(settings: SettingsFile): Promise<void> {
  const path = await resolveGlobalSettingsPath()
  await saveSettingsToPath(path, settings, 'global')
}

export async function loadProjectSettings(project: Project): Promise<SettingsFile> {
  const path = await resolveProjectSettingsPath(project)
  return loadSettingsFromPath(path, 'project')
}

export async function saveProjectSettings(project: Project, settings: SettingsFile): Promise<void> {
  const path = await resolveProjectSettingsPath(project)
  await saveSettingsToPath(path, stripGlobalOnlyKeys(settings), 'project')
}
