import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'

/** 终端标签显示「运行中 / 已完成未查看」。关闭时不轮询进程，默认关闭。 */
export const TERMINAL_ACTIVITY_INDICATOR_KEY = 'terminal.integrated.tabActivityIndicator'

export function parseTerminalActivityIndicator(value: unknown): boolean {
  return value === true
}

export function readTerminalActivityIndicator(settings: Record<string, unknown>): boolean {
  return parseTerminalActivityIndicator(settings[TERMINAL_ACTIVITY_INDICATOR_KEY])
}

let cachedEnabled = parseTerminalActivityIndicator(
  DEFAULT_GLOBAL_SETTINGS[TERMINAL_ACTIVITY_INDICATOR_KEY],
)
const listeners = new Set<() => void>()

export function getTerminalActivityIndicator(): boolean {
  return cachedEnabled
}

export function subscribeTerminalActivityIndicator(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setCachedTerminalActivityIndicator(enabled: boolean) {
  if (cachedEnabled === enabled) return
  cachedEnabled = enabled
  listeners.forEach(listener => listener())
}

export async function loadEffectiveTerminalActivityIndicator(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalActivityIndicator(mergeSettings(global, workspace))
  setCachedTerminalActivityIndicator(next)
  return next
}

export async function loadScopedTerminalActivityIndicator(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    return readTerminalActivityIndicator(await loadProjectSettings(project))
  }
  return readTerminalActivityIndicator(await loadGlobalSettings())
}

export async function saveScopedTerminalActivityIndicator(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[TERMINAL_ACTIVITY_INDICATOR_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[TERMINAL_ACTIVITY_INDICATOR_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveTerminalActivityIndicator(project)
}
