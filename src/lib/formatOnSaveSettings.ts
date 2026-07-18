import type { Project } from '../types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
} from './projectSettings'
import { mergeSettings } from './autoSaveSettings'

export const FORMAT_ON_SAVE_SETTINGS_EVENT = 'qingcode:format-on-save-changed'

export function parseFormatOnSave(value: unknown): boolean {
  return value === true
}

export function readFormatOnSave(settings: Record<string, unknown>): boolean {
  return parseFormatOnSave(settings['editor.formatOnSave'])
}

let cachedFormatOnSave = parseFormatOnSave(DEFAULT_GLOBAL_SETTINGS['editor.formatOnSave'])

export function getFormatOnSave(): boolean {
  return cachedFormatOnSave
}

export function notifyFormatOnSaveChanged(enabled: boolean) {
  cachedFormatOnSave = enabled === true
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(FORMAT_ON_SAVE_SETTINGS_EVENT, { detail: cachedFormatOnSave }),
  )
}

export async function loadEffectiveFormatOnSave(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readFormatOnSave(mergeSettings(global, workspace))
  notifyFormatOnSaveChanged(next)
  return next
}
