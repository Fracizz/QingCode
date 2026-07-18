import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  saveGlobalSettings,
} from './projectSettings'

export const UPDATE_CHECK_ON_STARTUP_KEY = 'qingcode.update.checkOnStartup'
export const UPDATE_SKIPPED_VERSION_KEY = 'qingcode.update.skippedVersion'
export const UPDATE_SETTINGS_EVENT = 'qingcode:update-settings-changed'

export type UpdateSettings = {
  checkOnStartup: boolean
  skippedVersion: string | null
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  checkOnStartup: true,
  skippedVersion: null,
}

export function parseCheckOnStartup(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return DEFAULT_UPDATE_SETTINGS.checkOnStartup
}

export function parseSkippedVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^v/i, '')
  return trimmed ? trimmed : null
}

export function readUpdateSettings(settings: Record<string, unknown>): UpdateSettings {
  return {
    checkOnStartup: parseCheckOnStartup(settings[UPDATE_CHECK_ON_STARTUP_KEY]),
    skippedVersion: parseSkippedVersion(settings[UPDATE_SKIPPED_VERSION_KEY]),
  }
}

export async function loadUpdateSettings(): Promise<UpdateSettings> {
  return readUpdateSettings(await loadGlobalSettings())
}

export async function saveCheckOnStartup(enabled: boolean): Promise<UpdateSettings> {
  const current = await loadGlobalSettings()
  current[UPDATE_CHECK_ON_STARTUP_KEY] = enabled
  await saveGlobalSettings(current)
  const next = readUpdateSettings(current)
  notifyUpdateSettingsChanged(next)
  return next
}

export async function saveSkippedVersion(version: string | null): Promise<UpdateSettings> {
  const current = await loadGlobalSettings()
  if (version) {
    current[UPDATE_SKIPPED_VERSION_KEY] = version.trim().replace(/^v/i, '')
  } else {
    delete current[UPDATE_SKIPPED_VERSION_KEY]
  }
  await saveGlobalSettings(current)
  const next = readUpdateSettings(current)
  notifyUpdateSettingsChanged(next)
  return next
}

export function isVersionSkipped(latest: string, skipped: string | null): boolean {
  if (!skipped) return false
  const a = latest.trim().replace(/^v/i, '')
  const b = skipped.trim().replace(/^v/i, '')
  return a.length > 0 && a === b
}

export function notifyUpdateSettingsChanged(settings: UpdateSettings) {
  window.dispatchEvent(new CustomEvent(UPDATE_SETTINGS_EVENT, { detail: settings }))
}

/** Ensure defaults object exposes the startup flag for Settings “modified” UI. */
export function defaultCheckOnStartup(): boolean {
  return parseCheckOnStartup(DEFAULT_GLOBAL_SETTINGS[UPDATE_CHECK_ON_STARTUP_KEY])
}
