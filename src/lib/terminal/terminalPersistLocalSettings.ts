import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  parseSettingsText,
  resolveGlobalSettingsPath,
  resolveProjectSettingsPath,
  saveGlobalSettings,
  saveProjectSettings,
  settingsFileExists,
  type SettingsFile,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'
import { safeInvoke } from '@/lib/tauri'

/** 开启（默认）时新建的本地交互式终端由本机宿主托管，应用重启后可接回。 */
export const PERSIST_LOCAL_SESSIONS_KEY = 'terminal.integrated.persistLocalSessions'

const LEGACY_DEFAULT_MIGRATE_FLAG = 'qingcode:persist-local-sessions-default-on-v1'
const PROJECT_LEGACY_DEFAULT_MIGRATE_PREFIX = 'qingcode:persist-local-sessions-default-on-project-v1:'

/** 默认开启：只有显式 false 才关闭，缺省或非法值按默认处理。 */
export function parseTerminalPersistLocalSessions(value: unknown): boolean {
  return typeof value === 'boolean'
    ? value
    : DEFAULT_GLOBAL_SETTINGS[PERSIST_LOCAL_SESSIONS_KEY] === true
}

export function readTerminalPersistLocalSessions(settings: Record<string, unknown>): boolean {
  return parseTerminalPersistLocalSessions(settings[PERSIST_LOCAL_SESSIONS_KEY])
}

let cachedPersistLocalSessions = parseTerminalPersistLocalSessions(
  DEFAULT_GLOBAL_SETTINGS[PERSIST_LOCAL_SESSIONS_KEY],
)

export function getTerminalPersistLocalSessions(): boolean {
  return cachedPersistLocalSessions
}

export function setCachedTerminalPersistLocalSessions(enabled: boolean) {
  cachedPersistLocalSessions = enabled === true
}

export async function loadEffectiveTerminalPersistLocalSessions(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalPersistLocalSessions(mergeSettings(global, workspace))
  setCachedTerminalPersistLocalSessions(next)
  return next
}

export async function loadScopedTerminalPersistLocalSessions(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    const global = await loadGlobalSettings()
    return readTerminalPersistLocalSessions(mergeSettings(global, await loadProjectSettings(project)))
  }
  return readTerminalPersistLocalSessions(await loadGlobalSettings())
}

export async function saveScopedTerminalPersistLocalSessions(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[PERSIST_LOCAL_SESSIONS_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[PERSIST_LOCAL_SESSIONS_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveTerminalPersistLocalSessions(project)
}

/**
 * 旧版默认关闭时，设置模板把 `false` 显式写进了设置文件，单改默认值对已有文件不生效。
 * 每个设置文件翻转一次；分不清模板写入和手动关闭，一律按旧默认处理。
 * 返回 true 表示 `settings` 已被修改。
 */
export function flipLegacyPersistLocalDefault(settings: SettingsFile): boolean {
  if (settings[PERSIST_LOCAL_SESSIONS_KEY] !== false) return false
  settings[PERSIST_LOCAL_SESSIONS_KEY] = true
  return true
}

/**
 * 工作区设置默认继承用户设置：旧工作区模板写入的 `false` 直接去掉，改为继承，
 * 而不是写成 `true`，避免工作区的显式值压过用户之后在全局中的选择。
 */
export function dropLegacyProjectPersistLocalOverride(settings: SettingsFile): boolean {
  if (settings[PERSIST_LOCAL_SESSIONS_KEY] !== false) return false
  delete settings[PERSIST_LOCAL_SESSIONS_KEY]
  return true
}

/** 标记写入前先占位，之后的启动不再读文件；localStorage 不可用时跳过迁移。 */
function claimMigration(flag: string): boolean {
  try {
    if (localStorage.getItem(flag)) return false
    localStorage.setItem(flag, '1')
    return true
  } catch {
    return false
  }
}

async function readSettingsIfPresent(
  path: string,
  scope: 'global' | 'project',
): Promise<SettingsFile | null> {
  if (!(await settingsFileExists(path))) return null
  const raw = await safeInvoke<string>('读取设置', 'read_file', { path })
  if (!raw.includes(PERSIST_LOCAL_SESSIONS_KEY)) return null
  return parseSettingsText(raw, scope)
}

/** 全局设置与当前工作区设置各迁移一次；迁移是尽力而为，读写失败直接忽略。 */
export async function migrateLegacyPersistLocalSessions(project?: Project | null): Promise<void> {
  if (typeof localStorage === 'undefined') return
  if (claimMigration(LEGACY_DEFAULT_MIGRATE_FLAG)) {
    try {
      const settings = await readSettingsIfPresent(await resolveGlobalSettingsPath(), 'global')
      if (settings && flipLegacyPersistLocalDefault(settings)) await saveGlobalSettings(settings)
    } catch {
      // Best effort.
    }
  }
  if (project && claimMigration(`${PROJECT_LEGACY_DEFAULT_MIGRATE_PREFIX}${project.path}`)) {
    try {
      const settings = await readSettingsIfPresent(await resolveProjectSettingsPath(project), 'project')
      if (settings && dropLegacyProjectPersistLocalOverride(settings)) await saveProjectSettings(project, settings)
    } catch {
      // Best effort.
    }
  }
}
