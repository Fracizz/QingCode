import type { Project } from '../types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  type SettingsFile,
} from './projectSettings'
import { mergeSettings } from './autoSaveSettings'

export const TERMINAL_SCROLLBACK_SETTINGS_EVENT = 'qingcode:terminal-scrollback-changed'

export const DEFAULT_TERMINAL_SCROLLBACK =
  DEFAULT_GLOBAL_SETTINGS['terminal.integrated.scrollback'] as number

/** Clamp to a practical range used by xterm + persistence. */
export const MIN_TERMINAL_SCROLLBACK = 100
export const MAX_TERMINAL_SCROLLBACK = 100_000

export function parseTerminalScrollback(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SCROLLBACK
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(n)))
}

export function readTerminalScrollback(settings: SettingsFile): number {
  return parseTerminalScrollback(settings['terminal.integrated.scrollback'])
}

let cachedScrollback = DEFAULT_TERMINAL_SCROLLBACK

export function getTerminalScrollback(): number {
  return cachedScrollback
}

export function notifyTerminalScrollbackChanged(scrollback: number) {
  cachedScrollback = parseTerminalScrollback(scrollback)
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(TERMINAL_SCROLLBACK_SETTINGS_EVENT, { detail: cachedScrollback }),
  )
}

export async function loadEffectiveTerminalScrollback(
  project?: Project | null,
): Promise<number> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalScrollback(mergeSettings(global, workspace))
  notifyTerminalScrollbackChanged(next)
  return next
}

/**
 * Approximate max retained characters/bytes for one terminal's ring buffer.
 * Keeps localStorage pressure bounded even with high scrollback line counts.
 */
export function scrollbackMaxChars(scrollbackLines: number = getTerminalScrollback()): number {
  const lines = parseTerminalScrollback(scrollbackLines)
  return Math.min(512 * 1024, Math.max(8 * 1024, lines * 200))
}
