import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'

export const SSH_UPLOAD_ON_PASTE_KEY = 'terminal.integrated.sshUploadOnPaste'
export const TERMINAL_SSH_UPLOAD_SETTINGS_EVENT = 'qingcode:terminal-ssh-upload-changed'

export function parseTerminalSshUploadOnPaste(value: unknown): boolean {
  return value === true
}

export function readTerminalSshUploadOnPaste(settings: Record<string, unknown>): boolean {
  return parseTerminalSshUploadOnPaste(settings[SSH_UPLOAD_ON_PASTE_KEY])
}

let cachedSshUploadOnPaste = parseTerminalSshUploadOnPaste(
  DEFAULT_GLOBAL_SETTINGS[SSH_UPLOAD_ON_PASTE_KEY],
)

export function getTerminalSshUploadOnPaste(): boolean {
  return cachedSshUploadOnPaste
}

export function notifyTerminalSshUploadOnPasteChanged(enabled: boolean) {
  cachedSshUploadOnPaste = enabled === true
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(TERMINAL_SSH_UPLOAD_SETTINGS_EVENT, { detail: cachedSshUploadOnPaste }),
  )
}

export async function loadEffectiveTerminalSshUploadOnPaste(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readTerminalSshUploadOnPaste(mergeSettings(global, workspace))
  notifyTerminalSshUploadOnPasteChanged(next)
  return next
}

export async function loadScopedTerminalSshUploadOnPaste(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  if (scope === 'project' && project) {
    return readTerminalSshUploadOnPaste(await loadProjectSettings(project))
  }
  return readTerminalSshUploadOnPaste(await loadGlobalSettings())
}

export async function saveScopedTerminalSshUploadOnPaste(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_UPLOAD_ON_PASTE_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_UPLOAD_ON_PASTE_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveTerminalSshUploadOnPaste(project)
}
