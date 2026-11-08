import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'

/** 开启后在 Agent / TUI 中 Shift+Enter 发送换行（判定见 terminalNewline.ts）。 */
export const SHIFT_ENTER_NEWLINE_KEY = 'terminal.integrated.shiftEnterNewline'

export function parseTerminalShiftEnterNewline(value: unknown): boolean {
  return value !== false
}

export function readTerminalShiftEnterNewline(settings: Record<string, unknown>): boolean {
  return parseTerminalShiftEnterNewline(settings[SHIFT_ENTER_NEWLINE_KEY])
}

let cachedShiftEnterNewline = parseTerminalShiftEnterNewline(
  DEFAULT_GLOBAL_SETTINGS[SHIFT_ENTER_NEWLINE_KEY],
)

export function getTerminalShiftEnterNewline(): boolean {
  return cachedShiftEnterNewline
}

export function setCachedTerminalShiftEnterNewline(enabled: boolean) {
  cachedShiftEnterNewline = enabled !== false
}

export async function loadEffectiveTerminalShiftEnterNewline(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalShiftEnterNewline(mergeSettings(global, workspace))
  setCachedTerminalShiftEnterNewline(next)
  return next
}

export async function loadScopedTerminalShiftEnterNewline(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    return readTerminalShiftEnterNewline(await loadProjectSettings(project))
  }
  return readTerminalShiftEnterNewline(await loadGlobalSettings())
}

export async function saveScopedTerminalShiftEnterNewline(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SHIFT_ENTER_NEWLINE_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SHIFT_ENTER_NEWLINE_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveTerminalShiftEnterNewline(project)
}
