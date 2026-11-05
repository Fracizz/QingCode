import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'

/** 开启后超大粘贴不再询问，直接存为文件并粘贴路径（阈值见 largePaste.ts）。 */
export const LARGE_PASTE_AS_FILE_KEY = 'terminal.integrated.largePasteAsFile'

export function parseTerminalLargePasteAsFile(value: unknown): boolean {
  return value === true
}

export function readTerminalLargePasteAsFile(settings: Record<string, unknown>): boolean {
  return parseTerminalLargePasteAsFile(settings[LARGE_PASTE_AS_FILE_KEY])
}

let cachedLargePasteAsFile = parseTerminalLargePasteAsFile(
  DEFAULT_GLOBAL_SETTINGS[LARGE_PASTE_AS_FILE_KEY],
)

export function getTerminalLargePasteAsFile(): boolean {
  return cachedLargePasteAsFile
}

export function setCachedTerminalLargePasteAsFile(enabled: boolean) {
  cachedLargePasteAsFile = enabled === true
}

export async function loadEffectiveTerminalLargePasteAsFile(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalLargePasteAsFile(mergeSettings(global, workspace))
  setCachedTerminalLargePasteAsFile(next)
  return next
}

export async function loadScopedTerminalLargePasteAsFile(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    return readTerminalLargePasteAsFile(await loadProjectSettings(project))
  }
  return readTerminalLargePasteAsFile(await loadGlobalSettings())
}

export async function saveScopedTerminalLargePasteAsFile(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[LARGE_PASTE_AS_FILE_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[LARGE_PASTE_AS_FILE_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveTerminalLargePasteAsFile(project)
}
