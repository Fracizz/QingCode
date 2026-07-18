import type { Project } from '../types'
import { mergeSettings } from './autoSaveSettings'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  parseSettingsText,
  resolveGlobalSettingsPath,
  saveGlobalSettings,
  saveProjectSettings,
  settingsFileExists,
  type SettingsFile,
} from './projectSettings'
import { safeInvoke } from './tauri'

export const MINIMAP_SETTINGS_EVENT = 'qingcode:minimap-settings-changed'

const LEGACY_MIGRATE_FLAG = 'qingcode:minimap-legacy-unplanned-v1'

export function parseMinimapEnabled(value: unknown): boolean {
  // Default on when key is missing (matches product default).
  if (value === undefined || value === null) return true
  return value === true
}

export function readMinimapEnabled(settings: Record<string, unknown>): boolean {
  return parseMinimapEnabled(settings['editor.minimap.enabled'])
}

let cachedMinimapEnabled = parseMinimapEnabled(
  DEFAULT_GLOBAL_SETTINGS['editor.minimap.enabled'],
)

export function getMinimapEnabled(): boolean {
  return cachedMinimapEnabled
}

export function notifyMinimapEnabledChanged(enabled: boolean) {
  cachedMinimapEnabled = enabled === true
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(MINIMAP_SETTINGS_EVENT, { detail: cachedMinimapEnabled }),
  )
}

export async function loadEffectiveMinimapEnabled(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readMinimapEnabled(mergeSettings(global, workspace))
  notifyMinimapEnabledChanged(next)
  return next
}

export async function loadScopedMinimapEnabled(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    return readMinimapEnabled(await loadProjectSettings(project))
  }
  return readMinimapEnabled(await loadGlobalSettings())
}

export async function saveScopedMinimapEnabled(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current['editor.minimap.enabled'] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current['editor.minimap.enabled'] = enabled
    await saveGlobalSettings(current)
  }
  // Reload effective (workspace may override) after scoped write.
  await loadEffectiveMinimapEnabled(project)
}

/**
 * One-time: old templates marked minimap as「不计划」with `false`.
 * Flip those to `true` so the new default takes effect without wiping
 * intentional `false` in files that never carried the「不计划」marker.
 */
export async function migrateLegacyMinimapSetting(): Promise<void> {
  if (typeof localStorage === 'undefined') return
  if (localStorage.getItem(LEGACY_MIGRATE_FLAG)) return
  localStorage.setItem(LEGACY_MIGRATE_FLAG, '1')

  try {
    const path = await resolveGlobalSettingsPath()
    if (!(await settingsFileExists(path))) return
    const raw = await safeInvoke<string>('读取设置', 'read_file', { path })
    if (!raw.includes('editor.minimap.enabled') || !raw.includes('不计划')) return

    const settings: SettingsFile = parseSettingsText(raw, 'global')
    if (settings['editor.minimap.enabled'] !== false) return

    settings['editor.minimap.enabled'] = true
    await saveGlobalSettings(settings)
    notifyMinimapEnabledChanged(true)
  } catch {
    // Migration is best-effort; ignore I/O failures.
  }
}
