/**
 * Global toggle for workspace session save/restore (editor tabs + terminal
 * metadata/scrollback). Cached in localStorage so boot hydrate can read it
 * synchronously before async settings JSON loads.
 */

import {
  DEFAULT_GLOBAL_SETTINGS,
  SESSION_PERSIST_KEY,
  loadGlobalSettings,
  saveGlobalSettings,
} from './projectSettings'
import { clearWorkspaceSession } from './workspaceSessionPersist'
import { clearTerminalOutputSnapshot } from '@/lib/terminal/terminalSessionPersist'

export { SESSION_PERSIST_KEY }

/**
 * 重新开启会话保存时立即落盘当前会话的回调。由 workspaceSessionSync 的
 * installWorkspaceSessionPersistence（main.tsx 启动时调用）注册，
 * 避免本模块静态依赖它（否则形成 terminalStore → 本模块 → workspaceSessionSync → terminalStore 环）。
 */
let resumeWorkspaceSessionPersist: (() => void) | null = null

export function registerSessionPersistResumeHandler(handler: () => void) {
  resumeWorkspaceSessionPersist = handler
}

export const SESSION_PERSIST_CACHE_KEY = 'qingcode:session-persist'
export const SESSION_PERSIST_EVENT = 'qingcode:session-persist-changed'

export const DEFAULT_SESSION_PERSIST = true

export function parseSessionPersist(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return DEFAULT_SESSION_PERSIST
}

function writeCache(enabled: boolean) {
  try {
    localStorage.setItem(SESSION_PERSIST_CACHE_KEY, enabled ? '1' : '0')
  } catch {
    /* private mode */
  }
}

/** Sync read used by boot hydrate / persist paths. Default preserves prior behavior (on). */
export function isSessionPersistEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_PERSIST_CACHE_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    /* ignore */
  }
  return parseSessionPersist(DEFAULT_GLOBAL_SETTINGS[SESSION_PERSIST_KEY])
}

export function readSessionPersist(settings: Record<string, unknown>): boolean {
  return parseSessionPersist(settings[SESSION_PERSIST_KEY])
}

export async function loadSessionPersistEnabled(): Promise<boolean> {
  try {
    const enabled = readSessionPersist(await loadGlobalSettings())
    writeCache(enabled)
    return enabled
  } catch {
    return isSessionPersistEnabled()
  }
}

export async function saveSessionPersistEnabled(enabled: boolean): Promise<boolean> {
  const current = await loadGlobalSettings()
  current[SESSION_PERSIST_KEY] = enabled
  await saveGlobalSettings(current)
  writeCache(enabled)
  if (!enabled) {
    clearWorkspaceSession()
    clearTerminalOutputSnapshot()
  } else {
    // Persist current in-memory session now that saving is allowed again.
    resumeWorkspaceSessionPersist?.()
  }
  notifySessionPersistChanged(enabled)
  return enabled
}

export function notifySessionPersistChanged(enabled: boolean) {
  window.dispatchEvent(
    new CustomEvent(SESSION_PERSIST_EVENT, { detail: { enabled } }),
  )
}
