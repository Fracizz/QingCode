/**
 * 全局开关：启动后在后台自动接回终端（不提示、不切换项目）。
 * 缓存到 localStorage，供远端遗留终端同步等同步路径直接读取。
 */

import { loadGlobalSettings, saveGlobalSettings } from './projectSettings'

/** 与 projectSettings 中的同名常量一致；本模块自带一份，测试替身不必导出它。 */
export const SESSION_AUTO_REATTACH_TERMINALS_KEY = 'qingcode.session.autoReattachTerminals'

export const TERMINAL_AUTO_REATTACH_CACHE_KEY = 'qingcode:terminal-auto-reattach'

export const DEFAULT_TERMINAL_AUTO_REATTACH = true

export function parseTerminalAutoReattach(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return DEFAULT_TERMINAL_AUTO_REATTACH
}

function writeCache(enabled: boolean) {
  try {
    localStorage.setItem(TERMINAL_AUTO_REATTACH_CACHE_KEY, enabled ? '1' : '0')
  } catch {
    /* private mode */
  }
}

export function isTerminalAutoReattachEnabled(): boolean {
  try {
    const raw = localStorage.getItem(TERMINAL_AUTO_REATTACH_CACHE_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    /* ignore */
  }
  return DEFAULT_TERMINAL_AUTO_REATTACH
}

export function readTerminalAutoReattach(settings: Record<string, unknown>): boolean {
  return parseTerminalAutoReattach(settings[SESSION_AUTO_REATTACH_TERMINALS_KEY])
}

export async function loadTerminalAutoReattachEnabled(): Promise<boolean> {
  try {
    const enabled = readTerminalAutoReattach(await loadGlobalSettings())
    writeCache(enabled)
    return enabled
  } catch {
    return isTerminalAutoReattachEnabled()
  }
}

export async function saveTerminalAutoReattachEnabled(enabled: boolean): Promise<boolean> {
  const current = await loadGlobalSettings()
  current[SESSION_AUTO_REATTACH_TERMINALS_KEY] = enabled
  await saveGlobalSettings(current)
  writeCache(enabled)
  return enabled
}
