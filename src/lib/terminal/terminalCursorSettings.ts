import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'

export const TERMINAL_CURSOR_SETTINGS_EVENT = 'qingcode:terminal-cursor-changed'

export function parseTerminalCursorBlinking(value: unknown): boolean {
  if (value === false) return false
  return true
}

export function readTerminalCursorBlinking(settings: Record<string, unknown>): boolean {
  return parseTerminalCursorBlinking(settings['terminal.integrated.cursorBlinking'])
}

let cachedCursorBlinking = parseTerminalCursorBlinking(
  DEFAULT_GLOBAL_SETTINGS['terminal.integrated.cursorBlinking'],
)

export function getTerminalCursorBlinking(): boolean {
  return cachedCursorBlinking
}

export function notifyTerminalCursorBlinkingChanged(blinking: boolean) {
  cachedCursorBlinking = blinking !== false
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(TERMINAL_CURSOR_SETTINGS_EVENT, { detail: cachedCursorBlinking }),
  )
}

export async function loadEffectiveTerminalCursorBlinking(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalCursorBlinking(mergeSettings(global, workspace))
  notifyTerminalCursorBlinkingChanged(next)
  return next
}
