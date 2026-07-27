import {
  DEFAULT_GLOBAL_SETTINGS,
  SESSION_EDITOR_STATE_CACHE_SIZE_KEY,
  loadGlobalSettings,
  saveGlobalSettings,
} from './projectSettings'
import { setEditorStateCacheMax } from './editorSession'

export type EditorStateCacheSizeSetting = 'auto' | number

export const DEFAULT_EDITOR_STATE_CACHE_SIZE = 12
export const MIN_EDITOR_STATE_CACHE_SIZE = 1
export const MAX_EDITOR_STATE_CACHE_SIZE = 100

export function parseEditorStateCacheSize(value: unknown): EditorStateCacheSizeSetting {
  if (value === 'auto' || value === undefined || value === null) return 'auto'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'auto'
  return Math.min(
    MAX_EDITOR_STATE_CACHE_SIZE,
    Math.max(MIN_EDITOR_STATE_CACHE_SIZE, Math.round(value))
  )
}

export function resolveEditorStateCacheSize(value: EditorStateCacheSizeSetting): number {
  return value === 'auto' ? DEFAULT_EDITOR_STATE_CACHE_SIZE : value
}

function applyEditorStateCacheSize(value: EditorStateCacheSizeSetting) {
  setEditorStateCacheMax(resolveEditorStateCacheSize(value))
}

export async function loadEditorStateCacheSize(): Promise<EditorStateCacheSizeSetting> {
  const settings = await loadGlobalSettings()
  const value = parseEditorStateCacheSize(settings[SESSION_EDITOR_STATE_CACHE_SIZE_KEY])
  applyEditorStateCacheSize(value)
  return value
}

export async function saveEditorStateCacheSize(
  value: EditorStateCacheSizeSetting
): Promise<EditorStateCacheSizeSetting> {
  const normalized = parseEditorStateCacheSize(value)
  const settings = await loadGlobalSettings()
  settings[SESSION_EDITOR_STATE_CACHE_SIZE_KEY] = normalized
  await saveGlobalSettings(settings)
  applyEditorStateCacheSize(normalized)
  return normalized
}

export function defaultEditorStateCacheSize(): EditorStateCacheSizeSetting {
  return parseEditorStateCacheSize(DEFAULT_GLOBAL_SETTINGS[SESSION_EDITOR_STATE_CACHE_SIZE_KEY])
}
