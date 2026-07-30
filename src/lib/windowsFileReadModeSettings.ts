import { isTauri, safeInvoke } from './tauri'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  saveGlobalSettings,
} from './projectSettings'

export const WINDOWS_FILE_READ_MODE_KEY = 'files.windowsReadMode'
export const WINDOWS_FILE_READ_MODE_EVENT = 'qingcode:windows-file-read-mode-changed'

export type WindowsFileReadMode = 'auto' | 'compatible' | 'native'

export const DEFAULT_WINDOWS_FILE_READ_MODE: WindowsFileReadMode = 'auto'

export function parseWindowsFileReadMode(value: unknown): WindowsFileReadMode {
  return value === 'auto' || value === 'native' || value === 'compatible'
    ? value
    : DEFAULT_WINDOWS_FILE_READ_MODE
}

export function readWindowsFileReadMode(
  settings: Record<string, unknown>,
): WindowsFileReadMode {
  return parseWindowsFileReadMode(settings[WINDOWS_FILE_READ_MODE_KEY])
}

async function applyWindowsFileReadMode(mode: WindowsFileReadMode): Promise<void> {
  if (!isTauri()) return
  await safeInvoke<void>('设置 Windows 文件读取模式', 'set_text_read_mode', { mode })
}

export async function loadWindowsFileReadMode(): Promise<WindowsFileReadMode> {
  const mode = readWindowsFileReadMode(await loadGlobalSettings())
  await applyWindowsFileReadMode(mode)
  return mode
}

export async function saveWindowsFileReadMode(
  mode: WindowsFileReadMode,
): Promise<WindowsFileReadMode> {
  const current = await loadGlobalSettings()
  current[WINDOWS_FILE_READ_MODE_KEY] = mode
  await saveGlobalSettings(current)
  await applyWindowsFileReadMode(mode)
  window.dispatchEvent(
    new CustomEvent(WINDOWS_FILE_READ_MODE_EVENT, { detail: { mode } }),
  )
  return mode
}

export function defaultWindowsFileReadMode(): WindowsFileReadMode {
  return readWindowsFileReadMode(DEFAULT_GLOBAL_SETTINGS)
}
