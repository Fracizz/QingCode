import type { Project } from '../types'
import { mergeExcludeMaps } from './excludeSettings'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  resolveProjectSettingsPath,
  saveGlobalSettings,
  saveProjectSettings,
  settingsFileExists,
  type SettingsFile,
} from './projectSettings'

export const AUTO_SAVE_SETTINGS_EVENT = 'qingcode:auto-save-settings-changed'

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange'

export const AUTO_SAVE_MODES: { value: AutoSaveMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'afterDelay', label: '延迟后' },
  { value: 'onFocusChange', label: '失去焦点时' },
  { value: 'onWindowChange', label: '窗口切换时' },
]

export const AUTO_SAVE_DELAY_OPTIONS = [500, 1000, 2000, 3000, 5000] as const

export type AutoSaveSettings = {
  mode: AutoSaveMode
  delay: number
}

export function parseAutoSaveMode(value: unknown): AutoSaveMode {
  if (value === 'afterDelay' || value === 'onFocusChange' || value === 'onWindowChange') {
    return value
  }
  return 'off'
}

export function parseAutoSaveDelay(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay'] as number
  return Math.min(10000, Math.max(500, Math.round(parsed)))
}

export function mergeSettings(global: SettingsFile, workspace?: SettingsFile | null): SettingsFile {
  const merged: SettingsFile = {
    ...global,
    custom: { ...global.custom },
  }
  if (!workspace) return merged
  for (const [key, value] of Object.entries(workspace)) {
    if (key === 'version' || key === 'custom') continue
    if (key === 'files.exclude' || key === 'search.exclude') {
      // Deep-merge exclude maps so workspace can flip individual patterns.
      merged[key] = mergeExcludeMaps(merged[key], value)
      continue
    }
    merged[key] = value
  }
  merged.custom = { ...merged.custom, ...(workspace.custom ?? {}) }
  return merged
}

export function readAutoSaveSettings(settings: SettingsFile): AutoSaveSettings {
  return {
    mode: parseAutoSaveMode(settings['files.autoSave']),
    delay: parseAutoSaveDelay(settings['files.autoSaveDelay']),
  }
}

const PROJECT_AUTOSAVE_INHERIT_MIGRATE_PREFIX = 'qingcode:autosave-project-inherit-v1:'

/**
 * Older project-settings templates always wrote `files.autoSave: "off"`, which
 * silently overrode the user's global afterDelay preference. Strip those default
 * keys once so workspace files only keep intentional overrides.
 */
export async function migrateLegacyProjectAutoSaveDefaults(
  project?: Project | null,
): Promise<boolean> {
  if (!project || typeof localStorage === 'undefined') return false
  const flag = `${PROJECT_AUTOSAVE_INHERIT_MIGRATE_PREFIX}${project.path}`
  if (localStorage.getItem(flag)) return false
  localStorage.setItem(flag, '1')

  try {
    const path = await resolveProjectSettingsPath(project)
    if (!(await settingsFileExists(path))) return false
    const settings = await loadProjectSettings(project)
    if (settings['files.autoSave'] !== 'off') return false

    delete settings['files.autoSave']
    if (
      settings['files.autoSaveDelay'] === undefined ||
      settings['files.autoSaveDelay'] === DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay']
    ) {
      delete settings['files.autoSaveDelay']
    }
    await saveProjectSettings(project, settings)
    return true
  } catch {
    return false
  }
}

export async function loadEffectiveAutoSaveSettings(
  project?: Project | null,
): Promise<AutoSaveSettings> {
  const global = await loadGlobalSettings()
  if (!project) return readAutoSaveSettings(global)
  const path = await resolveProjectSettingsPath(project)
  if (!(await settingsFileExists(path))) {
    return readAutoSaveSettings(global)
  }
  const workspace = await loadProjectSettings(project)
  return readAutoSaveSettings(mergeSettings(global, workspace))
}

export async function loadScopedAutoSaveSettings(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<AutoSaveSettings> {
  if (scope === 'project' && project) {
    return readAutoSaveSettings(await loadProjectSettings(project))
  }
  return readAutoSaveSettings(await loadGlobalSettings())
}

export async function saveScopedAutoSaveSettings(
  scope: 'global' | 'project',
  settings: AutoSaveSettings,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current['files.autoSave'] = settings.mode
    current['files.autoSaveDelay'] = settings.delay
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current['files.autoSave'] = settings.mode
    current['files.autoSaveDelay'] = settings.delay
    await saveGlobalSettings(current)
  }
  notifyAutoSaveSettingsChanged(settings)
}

export function notifyAutoSaveSettingsChanged(settings: AutoSaveSettings) {
  window.dispatchEvent(
    new CustomEvent(AUTO_SAVE_SETTINGS_EVENT, { detail: settings }),
  )
}
