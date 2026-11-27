import { isGlobalAccessMode } from '@qn/codex-client'
import type {
  AgentPrefs,
  AppSettings,
  AppSettingsPatch,
  SettingsAgentKind,
  SettingsDensity,
  SettingsSendKey,
  SettingsTheme,
} from '../../shared/backendApi'
import { DEFAULT_FONT_SIZES, FONT_SIZES_VERSION, resolveFontSizes, sanitizeFontSizes } from '../../shared/fontSizes'
import { isAutoArchiveDays } from '../../shared/backendApi'

// 设置的纯逻辑：默认值、白名单校验、深合并。IO 在 settingsStore.ts，两边共用同一份形状。
// 只保存路径字符串，不读取 CODEX_HOME / CLAUDE_CONFIG_DIR 的内容（合规 §3.2）。

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

export function isSettingsTheme(value: unknown): value is SettingsTheme {
  return value === 'dark' || value === 'gray' || value === 'light'
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
      theme: 'dark',
      ...DEFAULT_FONT_SIZES,
      fontSizesVersion: FONT_SIZES_VERSION,
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
  // 目标 id 来自线协议，用无原型对象避免 __proto__ 之类键污染全局。
  return Object.create(null) as AppSettings['agents']
}

/** 重建单个 agent 偏好：非法值丢弃，pi 不接受 configDir。 */
export function sanitizeAgentPrefs(agent: SettingsAgentKind, raw: unknown): AgentPrefs {
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

/** 把任意 JSON（含损坏/旧版本文件）收敛成完整的 AppSettings，未知字段一律丢弃。 */
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
      theme: isSettingsTheme(general.theme) ? general.theme : defaults.general.theme,
      globalAccessMode: isGlobalAccessMode(general.globalAccessMode) ? general.globalAccessMode : defaults.general.globalAccessMode,
      ...resolveFontSizes(general),
    },
    agents,
  }
}

/** 校验并裁剪 settings.save 的补丁；空字符串表示清空该路径。 */
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
  if (isSettingsTheme(general.theme)) nextGeneral.theme = general.theme
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

/** 深合并三层（general / targetId / agent），结果再过一次白名单，保证落盘形状干净。 */
export function mergeAppSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const base = sanitizeAppSettings(current)
  const delta = sanitizeSettingsPatch(patch)
  const general = { ...base.general, ...(delta.general ?? {}) }
  const agents = emptyAgentMap()
  for (const [targetId, prefs] of Object.entries(base.agents)) {
    agents[targetId] = { ...prefs }
  }
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
