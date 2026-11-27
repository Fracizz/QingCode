import { isGlobalAccessMode } from '@qn/codex-client'
import type {
  AgentPrefs,
  AppSettings,
  AppSettingsPatch,
  SettingsAgentKind,
  SettingsDensity,
  SettingsSendKey,
} from '../../../../shared/backendApi'
import { DEFAULT_FONT_SIZES, sanitizeFontSizes, type FontSizeKey } from '../../../../shared/fontSizes'
import { isAutoArchiveDays } from '../../../../shared/backendApi'

// 设置的纯逻辑：默认值/白名单/深合并与后端 settings/appSettings.ts 同形（两层各自独立，避免 renderer 打包 Node IO）。
// 界面元数据与搜索索引也放这里，便于单测覆盖合规文案与过滤规则。

export const SETTINGS_AGENTS: readonly SettingsAgentKind[] = ['codex', 'claude', 'pi']

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_TARGET_ID_LENGTH = 256
const MAX_PATH_LENGTH = 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isSettingsSendKey(value: unknown): value is SettingsSendKey {
  return value === 'enter' || value === 'ctrlEnter'
}

export function isSettingsDensity(value: unknown): value is SettingsDensity {
  return value === 'comfortable' || value === 'compact'
}

export function isSettingsAgent(value: unknown): value is SettingsAgentKind {
  return value === 'codex' || value === 'claude' || value === 'pi'
}

export function defaultAppSettings(): AppSettings {
  return {
    general: {
      sendKey: 'enter',
      autoConnectLast: true,
      autoArchiveDays: 0,
      defaultAgent: 'codex',
      globalAccessMode: 'default',
      density: 'comfortable',
      ...DEFAULT_FONT_SIZES,
    },
    agents: {},
  }
}

function trimPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > MAX_PATH_LENGTH || trimmed.includes('\0')) return undefined
  return trimmed
}

function validTargetId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TARGET_ID_LENGTH &&
    !value.includes('\0') &&
    !FORBIDDEN_KEYS.has(value)
  )
}

function emptyAgentMap(): AppSettings['agents'] {
  return Object.create(null) as AppSettings['agents']
}

function sanitizeAgentPrefs(agent: SettingsAgentKind, raw: unknown): AgentPrefs {
  const record = isRecord(raw) ? raw : {}
  const prefs: AgentPrefs = {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
  }
  if (typeof record.path === 'string') {
    const path = trimPath(record.path)
    if (path) prefs.path = path
  }
  if (agent !== 'pi' && typeof record.configDir === 'string') {
    const configDir = trimPath(record.configDir)
    if (configDir) prefs.configDir = configDir
  }
  return prefs
}

export function sanitizeAppSettings(raw: unknown): AppSettings {
  const root = isRecord(raw) ? raw : {}
  const general = isRecord(root.general) ? root.general : {}
  const defaults = defaultAppSettings()
  const agents = emptyAgentMap()
  const rawAgents = isRecord(root.agents) ? root.agents : {}
  for (const [targetId, value] of Object.entries(rawAgents)) {
    if (!validTargetId(targetId) || !isRecord(value)) continue
    const prefs: Partial<Record<SettingsAgentKind, AgentPrefs>> = Object.create(null)
    for (const agent of SETTINGS_AGENTS) {
      const item = value[agent]
      if (isRecord(item)) prefs[agent] = sanitizeAgentPrefs(agent, item)
    }
    agents[targetId] = prefs
  }
  return {
    general: {
      sendKey: isSettingsSendKey(general.sendKey) ? general.sendKey : defaults.general.sendKey,
      autoConnectLast:
        typeof general.autoConnectLast === 'boolean'
          ? general.autoConnectLast
          : defaults.general.autoConnectLast,
      defaultAgent: isSettingsAgent(general.defaultAgent)
        ? general.defaultAgent
        : defaults.general.defaultAgent,
      autoArchiveDays: isAutoArchiveDays(general.autoArchiveDays) ? general.autoArchiveDays : defaults.general.autoArchiveDays,
      density: isSettingsDensity(general.density) ? general.density : defaults.general.density,
      globalAccessMode: isGlobalAccessMode(general.globalAccessMode) ? general.globalAccessMode : defaults.general.globalAccessMode,
      ...DEFAULT_FONT_SIZES,
      ...sanitizeFontSizes(general),
    },
    agents,
  }
}

export function sanitizeSettingsPatch(raw: unknown): AppSettingsPatch {
  const root = isRecord(raw) ? raw : {}
  const patch: AppSettingsPatch = {}
  const general = isRecord(root.general) ? root.general : {}
  const nextGeneral: Partial<AppSettings['general']> = sanitizeFontSizes(general)
  if (isSettingsSendKey(general.sendKey)) nextGeneral.sendKey = general.sendKey
  if (typeof general.autoConnectLast === 'boolean') nextGeneral.autoConnectLast = general.autoConnectLast
  if (isAutoArchiveDays(general.autoArchiveDays)) nextGeneral.autoArchiveDays = general.autoArchiveDays
  if (isSettingsAgent(general.defaultAgent)) nextGeneral.defaultAgent = general.defaultAgent
  if (isGlobalAccessMode(general.globalAccessMode)) nextGeneral.globalAccessMode = general.globalAccessMode
  if (isSettingsDensity(general.density)) nextGeneral.density = general.density
  if (Object.keys(nextGeneral).length > 0) patch.general = nextGeneral

  const rawAgents = isRecord(root.agents) ? root.agents : {}
  const agents = Object.create(null) as NonNullable<AppSettingsPatch['agents']>
  let hasAgents = false
  for (const [targetId, value] of Object.entries(rawAgents)) {
    if (!validTargetId(targetId) || !isRecord(value)) continue
    const target = Object.create(null) as NonNullable<AppSettingsPatch['agents']>[string]
    let hasPrefs = false
    for (const agent of SETTINGS_AGENTS) {
      const item = value[agent]
      if (!isRecord(item)) continue
      const prefs: Partial<AgentPrefs> = {}
      if (typeof item.enabled === 'boolean') prefs.enabled = item.enabled
      if (typeof item.path === 'string') {
        const path = trimPath(item.path)
        if (path !== undefined) prefs.path = path
      }
      if (agent !== 'pi' && typeof item.configDir === 'string') {
        const configDir = trimPath(item.configDir)
        if (configDir !== undefined) prefs.configDir = configDir
      }
      if (Object.keys(prefs).length > 0) {
        target[agent] = prefs
        hasPrefs = true
      }
    }
    if (hasPrefs) {
      agents[targetId] = target
      hasAgents = true
    }
  }
  if (hasAgents) patch.agents = agents
  return patch
}

/** 乐观更新与后端深合并保持同一语义，失败时可用原对象原样回滚。 */
export function mergeAppSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const base = sanitizeAppSettings(current)
  const delta = sanitizeSettingsPatch(patch)
  const general = { ...base.general, ...(delta.general ?? {}) }
  const agents = emptyAgentMap()
  for (const [targetId, prefs] of Object.entries(base.agents)) agents[targetId] = { ...prefs }
  for (const [targetId, patchPrefs] of Object.entries(delta.agents ?? {})) {
    const existing = agents[targetId] ?? {}
    const merged: Partial<Record<SettingsAgentKind, AgentPrefs>> = { ...existing }
    for (const agent of SETTINGS_AGENTS) {
      const change = patchPrefs[agent]
      if (!change) continue
      merged[agent] = { ...(existing[agent] ?? { enabled: true }), ...change }
    }
    agents[targetId] = merged
  }
  return sanitizeAppSettings({ general, agents })
}

/** 未配置过的 agent 默认启用；关闭后不应出现在新建会话的选择器里。 */
export function agentPrefs(settings: AppSettings, targetId: string, agent: SettingsAgentKind): AgentPrefs {
  return settings.agents[targetId]?.[agent] ?? { enabled: true }
}

// ---------- 界面元数据 ----------

export type SettingsAgentInfo = {
  id: SettingsAgentKind
  label: string
  /** 官方多配置方式的环境变量名，pi 没有 */
  configEnv?: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR'
  loginPrefix: string
  loginCommand: string
  loginSuffix: string
  notes: readonly string[]
}

/** 静态登录说明：不检测凭据、不提供登录入口（合规 §3.2 / §3.3 / §5）。 */
export const SETTINGS_AGENT_INFO: readonly SettingsAgentInfo[] = [
  {
    id: 'codex',
    label: 'Codex',
    configEnv: 'CODEX_HOME',
    loginPrefix: '在终端运行',
    loginCommand: 'codex login',
    loginSuffix: '完成登录。',
    notes: ['认证由用户本人在官方程序里完成，QingCode Next 不保存任何凭据。'],
  },
  {
    id: 'claude',
    label: 'Claude',
    configEnv: 'CLAUDE_CONFIG_DIR',
    loginPrefix: '在终端运行',
    loginCommand: 'claude',
    loginSuffix: '后输入 /login，或在 Claude 自身配置 API key / Bedrock / Vertex。',
    notes: [
      '订阅登录仅限本人自用，推荐 API key 路径。',
      '认证由用户本人在官方程序里完成，QingCode Next 不保存任何凭据。',
    ],
  },
  {
    id: 'pi',
    label: 'pi',
    loginPrefix: '在终端运行',
    loginCommand: 'pi',
    loginSuffix: '完成提供方配置。',
    notes: ['pi 不经审批直接执行工具。'],
  },
]

export const SEND_KEY_OPTIONS: ReadonlyArray<{ value: SettingsSendKey; label: string }> = [
  { value: 'enter', label: 'Enter 发送（Shift+Enter 换行）' },
  { value: 'ctrlEnter', label: 'Ctrl+Enter 发送（Enter 换行）' },
]

export const DENSITY_OPTIONS: ReadonlyArray<{ value: SettingsDensity; label: string }> = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
]

export const FONT_SIZE_SETTINGS: ReadonlyArray<{
  id: FontSizeKey
  title: string
  description: string
  keywords: readonly string[]
}> = [
  { id: 'chatFontSize', title: '对话字号', description: '用户消息、回复正文和推理摘要。', keywords: ['对话', '聊天', '消息', 'chat'] },
  { id: 'composerFontSize', title: '输入框字号', description: '主对话和侧边聊天的消息输入框，以及编辑历史消息时的输入框。', keywords: ['输入框', '编辑消息', 'composer'] },
  { id: 'editorFontSize', title: '文件与差异字号', description: '代码编辑器、文件预览和差异内容。', keywords: ['文件', '编辑器', '代码', '差异', 'editor', 'diff'] },
  { id: 'terminalFontSize', title: '终端字号', description: '集成终端的命令输入和输出。', keywords: ['终端', '命令行', 'terminal'] },
  { id: 'sidebarFontSize', title: '侧栏导航字号', description: '左侧的目标切换器、新会话、已归档会话和底部入口。', keywords: ['左侧', '侧栏', '导航', '目标', 'sidebar'] },
  { id: 'projectFontSize', title: '项目字号', description: '左侧项目列表中的项目名称和重命名输入框。', keywords: ['左侧', '侧栏', '项目', 'project'] },
  { id: 'sessionFontSize', title: '会话字号', description: '左侧会话列表中的会话标题、时间和重命名输入框，以及归档列表中的会话标题。', keywords: ['左侧', '侧栏', '会话', '历史', 'thread', 'session'] },
]

export const THEME_OPTIONS: ReadonlyArray<{ value: string; label: string; disabled?: boolean; hint?: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色', disabled: true, hint: '即将支持' },
]

export const DEFAULT_AGENT_OPTIONS: ReadonlyArray<{ value: SettingsAgentKind; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'pi', label: 'pi' },
]

export type SettingsSectionId = 'general' | 'agents' | 'connections' | 'mobile' | 'about'

export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId
  label: string
  description: string
}> = [
  { id: 'general', label: '通用', description: '发送、启动、界面与默认 Agent' },
  { id: 'agents', label: 'Agent', description: '按目标启用、路径与官方配置目录' },
  { id: 'connections', label: '连接', description: '已保存的本机与远程目标' },
  { id: 'mobile', label: '手机连接', description: '手机网关、配对与证书' },
  { id: 'about', label: '关于', description: '版本与第三方声明' },
]

export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}

export type SettingItem = {
  id: string
  section: SettingsSectionId
  title: string
  keywords: readonly string[]
}

export const SETTING_ITEMS: readonly SettingItem[] = [
  {
    id: 'sendKey',
    section: 'general',
    title: '发送快捷键',
    keywords: ['enter', 'ctrl+enter', 'shift+enter', '发送', '快捷键', 'send', 'key'],
  },
  {
    id: 'autoConnectLast',
    section: 'general',
    title: '启动时自动连接上次使用的目标',
    keywords: ['启动', '自动连接', '目标', '开机', 'startup', 'reconnect'],
  },
  {
    id: 'defaultAgent',
    section: 'general',
    title: '新会话默认 Agent',
    keywords: ['默认', '新会话', 'codex', 'claude', 'pi', 'agent'],
  },
  {
    id: 'autoArchiveDays',
    section: 'general',
    title: '自动归档不活跃的会话',
    keywords: ['归档', '会话管理', '聊天', '本机', 'archive'],
  },
  {
    id: 'globalAccessMode',
    section: 'general',
    title: '权限总控',
    keywords: ['权限', '总控', '继承', '访问模式', '只读', '计划模式', '完全访问', '跳过审批', 'permission', 'access'],
  },
  {
    id: 'density',
    section: 'general',
    title: '界面密度',
    keywords: ['密度', '舒适', '紧凑', '界面', 'density', 'compact'],
  },
  {
    id: 'theme',
    section: 'general',
    title: '主题',
    keywords: ['主题', '深色', '浅色', '外观', 'theme', 'dark', 'light', '即将支持'],
  },
  ...FONT_SIZE_SETTINGS.map(({ id, title, keywords }) => ({
    id,
    section: 'general' as const,
    title,
    keywords: ['字体', '字体大小', '字号', 'font size', ...keywords],
  })),
  {
    id: 'agents',
    section: 'agents',
    title: 'Agent 可用性与路径',
    keywords: [
      'agent', 'codex', 'claude', 'pi', '启用', '可执行文件', '路径', '检测', '版本',
      'codex_home', 'claude_config_dir', '登录', '凭据', '审批', 'probe',
    ],
  },
  {
    id: 'connections',
    section: 'connections',
    title: '已保存的连接',
    keywords: ['连接', '目标', 'ssh', '主机', '编辑', '删除', '地址', 'connection', '直连'],
  },
  {
    id: 'mobile',
    section: 'mobile',
    title: '手机连接',
    keywords: ['手机', '配对', '网关', '证书', '地址', 'frp', '设备', '密码', 'mobile'],
  },
  {
    id: 'about',
    section: 'about',
    title: '关于',
    keywords: ['关于', '版本', '第三方', '开源', 'qingcode', 'openai', 'anthropic', 'about'],
  },
]

export type SettingsFilter = {
  query: string
  sections: Array<{ id: SettingsSectionId; itemIds: string[] }>
  itemIds: string[]
  empty: boolean
}

/** 多关键字按 AND 匹配标题/关键字；空查询返回全部。 */
export function filterSettings(query: string): SettingsFilter {
  const normalized = query.trim().toLowerCase()
  const tokens = normalized ? normalized.split(/\s+/) : []
  const matches = (item: SettingItem): boolean => {
    if (tokens.length === 0) return true
    const haystack = `${item.title} ${item.keywords.join(' ')}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  }
  const itemIds = SETTING_ITEMS.filter(matches).map((item) => item.id)
  const sections = SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    itemIds: itemIds.filter((id) => SETTING_ITEMS.some((item) => item.id === id && item.section === section.id)),
  })).filter((section) => section.itemIds.length > 0)
  return { query: normalized, sections, itemIds, empty: itemIds.length === 0 }
}

/** 界面密度只提供 token 钩子，具体 CSS 由宿主在 html[data-density] 下定义。 */
export function densityAttribute(density: SettingsDensity): SettingsDensity {
  return density
}
