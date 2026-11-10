import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'

/** 开启后新建的本地交互式终端由本机宿主托管，应用重启后可接回。 */
export const PERSIST_LOCAL_SESSIONS_KEY = 'terminal.integrated.persistLocalSessions'

export function parseTerminalPersistLocalSessions(value: unknown): boolean {
  return typeof value === 'boolean'
    ? value
    : DEFAULT_GLOBAL_SETTINGS[PERSIST_LOCAL_SESSIONS_KEY] === true
}

export function readTerminalPersistLocalSessions(settings: Record<string, unknown>): boolean {
  return parseTerminalPersistLocalSessions(settings[PERSIST_LOCAL_SESSIONS_KEY])
}

let cachedPersistLocalSessions = parseTerminalPersistLocalSessions(
  DEFAULT_GLOBAL_SETTINGS[PERSIST_LOCAL_SESSIONS_KEY],
)

export function getTerminalPersistLocalSessions(): boolean {
  return cachedPersistLocalSessions
}

export function setCachedTerminalPersistLocalSessions(enabled: boolean) {
  cachedPersistLocalSessions = enabled === true
}

export async function loadEffectiveTerminalPersistLocalSessions(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalPersistLocalSessions(mergeSettings(global, workspace))
  setCachedTerminalPersistLocalSessions(next)
  return next
}

export async function loadScopedTerminalPersistLocalSessions(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    const global = await loadGlobalSettings()
    return readTerminalPersistLocalSessions(mergeSettings(global, await loadProjectSettings(project)))
  }
  return readTerminalPersistLocalSessions(await loadGlobalSettings())
}

export async function saveScopedTerminalPersistLocalSessions(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[PERSIST_LOCAL_SESSIONS_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[PERSIST_LOCAL_SESSIONS_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveTerminalPersistLocalSessions(project)
}
