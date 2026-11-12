import type { Project } from '@/types'
import {
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'

export const TERMINAL_PASTE_RETENTION_KEY = 'terminal.integrated.pasteRetentionDays'
export type TerminalPasteRetentionDays = 0 | 7 | 15 | 30

export function parseTerminalPasteRetentionDays(value: unknown): TerminalPasteRetentionDays {
  return value === 7 || value === 15 || value === 30 ? value : 0
}

export async function loadScopedTerminalPasteRetentionDays(
  scope: 'global' | 'project', project?: Project | null,
): Promise<TerminalPasteRetentionDays> {
  const global = await loadGlobalSettings()
  const workspace = scope === 'project' && project ? await loadProjectSettings(project) : null
  return parseTerminalPasteRetentionDays(
    workspace?.[TERMINAL_PASTE_RETENTION_KEY] ?? global[TERMINAL_PASTE_RETENTION_KEY],
  )
}

export async function saveScopedTerminalPasteRetentionDays(
  scope: 'global' | 'project', days: TerminalPasteRetentionDays, project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const settings = await loadProjectSettings(project)
    settings[TERMINAL_PASTE_RETENTION_KEY] = days
    await saveProjectSettings(project, settings)
  } else {
    const settings = await loadGlobalSettings()
    settings[TERMINAL_PASTE_RETENTION_KEY] = days
    await saveGlobalSettings(settings)
  }
}
