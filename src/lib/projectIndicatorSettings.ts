import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  saveGlobalSettings,
} from './projectSettings'

export const PROJECT_INDICATORS_ENABLED_KEY = 'qingcode.projectIndicators.enabled'
export const PROJECT_INDICATORS_EVENT = 'qingcode:project-indicators-changed'
export const PROJECT_INDICATORS_CACHE_KEY = 'qingcode:project-indicators-enabled'

export const DEFAULT_PROJECT_INDICATORS_ENABLED = true

export function parseProjectIndicatorsEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return DEFAULT_PROJECT_INDICATORS_ENABLED
}

let cachedEnabled = parseProjectIndicatorsEnabled(
  DEFAULT_GLOBAL_SETTINGS[PROJECT_INDICATORS_ENABLED_KEY],
)

function writeCache(enabled: boolean) {
  try {
    localStorage.setItem(PROJECT_INDICATORS_CACHE_KEY, enabled ? '1' : '0')
  } catch {
    /* private mode */
  }
}

export function isProjectIndicatorsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(PROJECT_INDICATORS_CACHE_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    /* ignore */
  }
  return cachedEnabled
}

export function readProjectIndicatorsEnabled(settings: Record<string, unknown>): boolean {
  return parseProjectIndicatorsEnabled(settings[PROJECT_INDICATORS_ENABLED_KEY])
}

export async function loadProjectIndicatorsEnabled(): Promise<boolean> {
  try {
    const enabled = readProjectIndicatorsEnabled(await loadGlobalSettings())
    cachedEnabled = enabled
    writeCache(enabled)
    return enabled
  } catch {
    return isProjectIndicatorsEnabled()
  }
}

export async function saveProjectIndicatorsEnabled(enabled: boolean): Promise<boolean> {
  const current = await loadGlobalSettings()
  current[PROJECT_INDICATORS_ENABLED_KEY] = enabled
  await saveGlobalSettings(current)
  cachedEnabled = enabled
  writeCache(enabled)
  notifyProjectIndicatorsChanged(enabled)
  return enabled
}

export function notifyProjectIndicatorsChanged(enabled: boolean) {
  cachedEnabled = enabled
  window.dispatchEvent(
    new CustomEvent(PROJECT_INDICATORS_EVENT, { detail: { enabled } }),
  )
}

export function defaultProjectIndicatorsEnabled(): boolean {
  return parseProjectIndicatorsEnabled(DEFAULT_GLOBAL_SETTINGS[PROJECT_INDICATORS_ENABLED_KEY])
}
