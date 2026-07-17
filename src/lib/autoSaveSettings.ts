import type { Project } from '../types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
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

export async function loadEffectiveAutoSaveSettings(
  project?: Project | null,
): Promise<AutoSaveSettings> {
  const global = await loadGlobalSettings()
  if (!project) return readAutoSaveSettings(global)
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
