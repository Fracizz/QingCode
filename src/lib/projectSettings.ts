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
export const UPDATE_CHECK_ON_STARTUP_KEY = 'qingcode.update.checkOnStartup'
export const UPDATE_SKIPPED_VERSION_KEY = 'qingcode.update.skippedVersion'
/** Persist/restore editor tabs + terminal sessions across app restarts. */
export const SESSION_PERSIST_KEY = 'qingcode.session.persist'

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
    'editor.formatOnSave': false,
    'editor.formatOnPaste': false,
    'editor.minimap.enabled': true,
    'editor.linkedEditing': false,
    'editor.bracketPairColorization.enabled': true,
    'editor.guides.enabled': true,
    'editor.guides.bracketPairs': true,
    'editor.guides.indentation': true,
    'editor.guides.highlightActiveIndentation': true,
    'files.autoSave': 'off',
    'files.autoSaveDelay': 1000,
    'files.eol': 'auto',
    'files.encoding': 'auto',
    'files.trimTrailingWhitespace': false,
    'files.insertFinalNewline': false,
    // Max size for rich/degraded CodeMirror edit (bytes or "20MB"). Plain edit stays ≤100MB; view ≤500MB.
    'files.maxSizeForEdit': {
      '*': 20 * 1024 * 1024,
      '*.log': 50 * 1024 * 1024,
      '*.txt': 50 * 1024 * 1024,
      '*.out': 50 * 1024 * 1024,
      '*.err': 50 * 1024 * 1024,
    },
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
    'search.followSymlinks': false,
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
  [UPDATE_CHECK_ON_STARTUP_KEY]: true,
  [SESSION_PERSIST_KEY]: true,
}

/** Workspace `.qingcode/project-settings.json` defaults (no project list — global-only). */
export const DEFAULT_PROJECT_SETTINGS: SettingsFile = buildSharedDefaults()

/** @deprecated Prefer DEFAULT_GLOBAL_SETTINGS */
export const DEFAULT_SETTINGS = DEFAULT_GLOBAL_SETTINGS

const SHARED_SETTINGS_BODY = `
  // ============================== 编辑器 ==============================
  // editor.fontSize：编辑器字号（像素）
  "editor.fontSize": 14,
  // editor.tabSize：Tab 宽度（空格数）。insertSpaces 为 true 时按空格缩进
  "editor.tabSize": 4,
  // editor.insertSpaces：true = 按空格缩进；false = 插入 Tab 字符
  "editor.insertSpaces": true,
  // editor.detectIndentation：打开文件时是否根据内容自动推断缩进风格
  "editor.detectIndentation": true,
  // editor.wordWrap：自动换行 off | on | wordWrapColumn | bounded
  "editor.wordWrap": "off",
  // editor.lineNumbers：行号显示 on | off | relative | interval
  "editor.lineNumbers": "on",
  // editor.renderWhitespace：空白字符渲染 none | boundary | selection | trailing | all
  "editor.renderWhitespace": "selection",
  // editor.formatOnSave：保存时自动格式化（format_document；可用 Shift+Alt+F 手动格式化）
  "editor.formatOnSave": false,
  // editor.formatOnPaste：粘贴后自动格式化（大文件/不支持语言会跳过）
  "editor.formatOnPaste": false,
  // editor.minimap.enabled：编辑区右侧代码小地图（≤1MB 语法色；1–5MB 密度条；>5MB 隐藏）
  "editor.minimap.enabled": true,
  // editor.linkedEditing：【不计划】链接编辑 / HTML 标签同步改名（保留键以免旧配置报错）
  "editor.linkedEditing": false,
  // editor.bracketPairColorization.enabled：括号对着色（按嵌套深度分色）
  "editor.bracketPairColorization.enabled": true,
  // editor.guides.enabled：参考线总开关（普通缩进线、活动高亮线和括号线）
  "editor.guides.enabled": true,
  // editor.guides.bracketPairs：显示多行括号对参考线；光标所在括号线只切换为高亮色
  "editor.guides.bracketPairs": true,
  // editor.guides.indentation：各级缩进参考线（默认浅色虚线）
  "editor.guides.indentation": true,
  // editor.guides.highlightActiveIndentation：高亮光标所在行的缩进参考线（实线）
  "editor.guides.highlightActiveIndentation": true,

  // ============================== 文件 ==============================
  // files.autoSave：自动保存 off | afterDelay | onFocusChange | onWindowChange
  "files.autoSave": "off",
  // files.autoSaveDelay：afterDelay 模式下的延迟（毫秒）
  "files.autoSaveDelay": 1000,
  // files.eol：换行符 auto | LF | CRLF（保存时生效）
  "files.eol": "auto",
  // files.encoding：默认文件编码 auto | utf8 | utf8bom | utf16le | utf16be | gbk | gb18030
  //（auto 依次检查 UTF-8/UTF-16 BOM、UTF-8、GB18030；无 BOM 的 UTF-16 需手动指定；大文件只读分片仍按 UTF-8）
  "files.encoding": "auto",
  // files.trimTrailingWhitespace：保存时去掉行尾空格
  "files.trimTrailingWhitespace": false,
  // files.insertFinalNewline：保存时确保文件以空行结尾
  "files.insertFinalNewline": false,
  // files.maxSizeForEdit：按 glob 覆盖「富文本/降级编辑」上限（字节或 "50MB" 字符串；更具体模式优先）
  // - "*" 默认 20MB；*.log / *.txt 等 50MB
  // - 纯文本整缓冲编辑硬顶仍为 100MB；只读分块预览硬顶 500MB（不可通过此项提高）
  "files.maxSizeForEdit": {
    // 默认上限（约 20MB）
    "*": 20971520,
    // 常见日志/文本放宽到约 50MB
    "*.log": 52428800,
    "*.txt": 52428800,
    "*.out": 52428800,
    "*.err": 52428800,
  },
  // files.exclude：资源管理器隐藏规则（VS Code 风格 glob；true=隐藏，false=强制显示）
  "files.exclude": {
    // 版本控制元数据
    "**/.git": true,
    "**/.svn": true,
    "**/.hg": true,
    "**/CVS": true,
    // 系统垃圾文件
    "**/.DS_Store": true,
    "**/Thumbs.db": true,
    // 依赖与构建产物
    "**/node_modules": true,
    "**/dist": true,
    "**/build": true,
    "**/target": true,
    // QingCode 项目配置目录默认显示，便于编辑
    "**/.qingcode": false,
  },

  // ============================== 搜索 ==============================
  // search.exclude：全文/文件名搜索排除（在 files.exclude 之上叠加；保存后立即生效）
  "search.exclude": {
    // 依赖目录
    "**/node_modules": true,
    "**/bower_components": true,
    // 构建产物
    "**/dist": true,
    "**/build": true,
    "**/target": true,
    // VS Code 搜索会话文件
    "**/*.code-search": true,
  },
  // search.followSymlinks：搜索是否跟随符号链接（默认 false，避免环与逃出工作区）
  "search.followSymlinks": false,
  // search.useIgnoreFiles：内容/文件名搜索是否读取 .gitignore、.ignore 等 ignore 文件
  "search.useIgnoreFiles": true,
  // explorer.excludeGitIgnore：资源管理器是否按 .gitignore 等 ignore 文件隐藏条目
  "explorer.excludeGitIgnore": true,

  // ============================== 终端 ==============================
  // terminal.integrated.scrollback：终端回滚缓冲行数（xterm scrollback + 会话输出持久化共用）
  "terminal.integrated.scrollback": 5000,
  // terminal.integrated.cursorBlinking：终端光标是否闪烁
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
  // - 各配置项上方均有对应注释；【不得删除注释】（含本文件头与各项说明）
  // - 改完后 Ctrl+S 保存；部分项需重启或重开文件后生效
  // =============================================================================
  // version：设置文件 schema 版本（当前固定为 1）
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
  //
  // qingcode.update.checkOnStartup
  //   true  = 正式构建启动约 3 秒后自动检查 Gitee/GitHub Release
  //   false = 仅通过设置 → 功能 →「检查更新」手动检查
  "qingcode.update.checkOnStartup": true,
  //
  // qingcode.update.skippedVersion
  //   跳过的版本号（不含 v）；与远端最新版本相同时不再弹窗提示
  // "qingcode.update.skippedVersion": "0.1.4",
  //
  // qingcode.session.persist
  //   true  = 重启后恢复编辑器标签、终端元数据与滚动缓冲（默认）
  //   false = 不保存/不恢复会话状态；关闭后会清除已缓存的会话快照
  "qingcode.session.persist": true,

  // ============================== 自定义扩展 ==============================
  // custom：自由键值，供后续功能读取；请勿删除整个 custom 对象
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
  // - 各配置项上方均有对应注释；【不得删除注释】（含本文件头与各项说明）
  // =============================================================================
  // version：设置文件 schema 版本（当前固定为 1）
  version: 1,
${SHARED_SETTINGS_BODY}
  // ============================== 自定义扩展 ==============================
  // custom：自由键值，供后续功能读取；请勿删除整个 custom 对象
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

/** JSON5 value text suitable after `key:` (multi-line values indented by `baseIndent`). */
function formatJson5AssignedValue(value: unknown, baseIndent: number): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  const raw = JSON5.stringify(value, null, 2)
  if (!raw.includes('\n')) return raw
  const pad = ' '.repeat(baseIndent)
  return raw
    .split('\n')
    .map((line, index) => (index === 0 ? line : pad + line))
    .join('\n')
}

/**
 * Replace a top-level `key: value` / `"key": value` assignment in a commented JSON5
 * template. Nested braces/brackets are matched so object values can be swapped whole.
 */
export function replaceTopLevelJson5Value(
  text: string,
  key: string,
  valueText: string,
  quotedKey = true,
): string {
  const keyToken = quotedKey ? `"${key}"` : key
  const prefix = `  ${keyToken}:`
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) {
      start = i
      break
    }
  }
  if (start < 0) return text

  const afterColon = lines[start].slice(prefix.length).trimStart()
  let end = start
  if (afterColon.startsWith('{') || afterColon.startsWith('[')) {
    const open = afterColon[0]
    const close = open === '{' ? '}' : ']'
    let balance = 0
    for (let i = start; i < lines.length; i++) {
      const chunk = i === start ? afterColon : lines[i]
      for (const ch of chunk) {
        if (ch === open) balance++
        else if (ch === close) balance--
      }
      if (balance === 0) {
        end = i
        break
      }
    }
  }

  const trimmed = valueText.trim()
  const valueLines = trimmed.split('\n')
  const replacement =
    valueLines.length === 1
      ? [`  ${keyToken}: ${valueLines[0]},`]
      : [
          `  ${keyToken}: ${valueLines[0]}`,
          ...valueLines.slice(1, -1),
          `${valueLines[valueLines.length - 1]},`,
        ]
  lines.splice(start, end - start + 1, ...replacement)
  return lines.join('\n')
}

/**
 * Emit the commented JSON5 template with `settings` values applied.
 * Keys that still match defaults keep the template’s nested comments.
 */
export function formatSettings(
  settings: SettingsFile = DEFAULT_GLOBAL_SETTINGS,
  scope: SettingsScope = 'global',
): string {
  const defaults = defaultSettingsFor(scope)
  const normalized = scope === 'project' ? stripGlobalOnlyKeys(settings) : settings
  const merged: SettingsFile = {
    ...defaults,
    ...normalized,
    version: 1,
    custom: isRecord(normalized.custom) ? normalized.custom : {},
  }

  if (settingsAreDefaultShape(merged, defaults)) {
    return defaultSettingsTextFor(scope)
  }

  let text = defaultSettingsTextFor(scope)
  text = replaceTopLevelJson5Value(text, 'version', String(merged.version ?? 1), false)

  for (const key of Object.keys(defaults)) {
    if (key === 'version' || key === 'custom') continue
    if (!(key in merged)) continue
    if (jsonValueEqual(merged[key], defaults[key])) continue
    const formatted = formatJson5AssignedValue(merged[key], 2)
    text = replaceTopLevelJson5Value(text, key, formatted, true)
  }

  if (!jsonValueEqual(merged.custom, defaults.custom ?? {})) {
    text = replaceTopLevelJson5Value(
      text,
      'custom',
      formatJson5AssignedValue(merged.custom ?? {}, 2),
      false,
    )
  }

  // Optional skipped-version key (commented in the template by default).
  const skipped = merged[UPDATE_SKIPPED_VERSION_KEY]
  if (typeof skipped === 'string' && skipped.trim()) {
    const line = `  "${UPDATE_SKIPPED_VERSION_KEY}": ${JSON.stringify(skipped.trim())},`
    if (text.includes(`// "${UPDATE_SKIPPED_VERSION_KEY}"`)) {
      text = text.replace(
        new RegExp(`\\s*//\\s*"${UPDATE_SKIPPED_VERSION_KEY}"\\s*:\\s*"[^"]*"\\s*,?`),
        `\n${line}`,
      )
    } else if (!text.includes(`"${UPDATE_SKIPPED_VERSION_KEY}"`)) {
      text = text.replace(
        /(\n {2}\/\/ ============================== 自定义扩展)/,
        `\n${line}$1`,
      )
    }
  }

  return text.endsWith('\n') ? text : `${text}\n`
}

/** Deep equality for JSON-like values; object key order does not matter. */
function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonValueEqual(item, b[index]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!jsonValueEqual(a[key], b[key])) return false
  }
  return true
}

function settingsAreDefaultShape(settings: SettingsFile, defaults: SettingsFile): boolean {
  return jsonValueEqual(settings, defaults)
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
 *   the commented template while preserving current values.
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
      const content = formatSettings(parsed, scope)
      await safeInvoke('保存设置', 'write_file', { path, content })
      return parsed
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
  const normalized = resolvedScope === 'project' ? stripGlobalOnlyKeys(settings) : settings
  const content = formatSettings(normalized, resolvedScope)

  // Avoid wiping a hand-edited commented file when values are unchanged.
  // Default-shaped saves always re-emit the commented template via formatSettings.
  try {
    const existing = await safeInvoke<string>('读取设置', 'read_file', { path })
    if (
      settingsTextHasComments(existing) &&
      !settingsAreDefaultShape(normalized, defaultSettingsFor(resolvedScope)) &&
      jsonValueEqual(parseSettingsText(existing, resolvedScope), normalized)
    ) {
      return
    }
  } catch {
    // File missing or unreadable — write below.
  }

  await safeInvoke('保存设置', 'write_file', {
    path,
    content,
  })
}

export async function loadGlobalSettings(): Promise<SettingsFile> {
  const path = await resolveGlobalSettingsPath()
  // Upgrade bare (uncommented) default-shaped files back to the commented template.
  if (await settingsFileExists(path)) {
    return ensureSettingsFile(path, { scope: 'global', upgradeComments: true })
  }
  return defaultSettingsFor('global')
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
