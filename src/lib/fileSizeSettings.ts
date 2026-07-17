import type { Project } from '../types'
import { loadGlobalSettings, loadProjectSettings, type SettingsFile } from './projectSettings'
import {
  DEFAULT_MAX_SIZE_FOR_EDIT,
  PLAIN_EDIT_MAX_BYTES,
  parseMaxSizeForEditMap,
  parseSizeToBytes,
  setActiveMaxSizeForEdit,
  type MaxSizeForEditMap,
} from './fileSizePolicy'

export const FILE_SIZE_SETTINGS_EVENT = 'qingcode:file-size-settings-changed'

export type FileSizePreferenceSettings = {
  maxSizeForEdit: MaxSizeForEditMap
}

export const DEFAULT_FILE_SIZE_PREFERENCES: FileSizePreferenceSettings = {
  maxSizeForEdit: { ...DEFAULT_MAX_SIZE_FOR_EDIT },
}

export function readFileSizePreferences(settings: SettingsFile): FileSizePreferenceSettings {
  return {
    maxSizeForEdit: parseMaxSizeForEditMap(settings['files.maxSizeForEdit']),
  }
}

/**
 * Merge global + workspace `files.maxSizeForEdit` maps (workspace keys overlay).
 * Missing workspace key keeps global/defaults entirely.
 */
export function mergeMaxSizeForEditMaps(
  globalSettings: SettingsFile,
  workspaceSettings?: SettingsFile | null,
): MaxSizeForEditMap {
  const merged = parseMaxSizeForEditMap(globalSettings['files.maxSizeForEdit'])
  const raw = workspaceSettings?.['files.maxSizeForEdit']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return merged
  for (const [pattern, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = pattern.trim()
    if (!key) continue
    const bytes = parseSizeToBytes(value)
    if (bytes == null) continue
    merged[key] = Math.min(PLAIN_EDIT_MAX_BYTES, Math.max(1, Math.floor(bytes)))
  }
  return merged
}

let cached: FileSizePreferenceSettings = {
  maxSizeForEdit: { ...DEFAULT_MAX_SIZE_FOR_EDIT },
}

export function getFileSizePreferences(): FileSizePreferenceSettings {
  return cached
}

export function notifyFileSizeSettingsChanged(settings: FileSizePreferenceSettings) {
  cached = { maxSizeForEdit: { ...settings.maxSizeForEdit } }
  setActiveMaxSizeForEdit(cached.maxSizeForEdit)
  window.dispatchEvent(new CustomEvent(FILE_SIZE_SETTINGS_EVENT, { detail: cached }))
}

export async function loadEffectiveFileSizePreferences(
  project?: Project | null,
): Promise<FileSizePreferenceSettings> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next: FileSizePreferenceSettings = {
    maxSizeForEdit: mergeMaxSizeForEditMaps(global, workspace),
  }
  notifyFileSizeSettingsChanged(next)
  return next
}
