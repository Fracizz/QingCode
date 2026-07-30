// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadGlobalSettings: vi.fn(),
  saveGlobalSettings: vi.fn(),
  safeInvoke: vi.fn(),
}))

vi.mock('./projectSettings', () => ({
  DEFAULT_GLOBAL_SETTINGS: { 'files.windowsReadMode': 'auto' },
  loadGlobalSettings: mocks.loadGlobalSettings,
  saveGlobalSettings: mocks.saveGlobalSettings,
}))

vi.mock('./tauri', () => ({
  isTauri: () => true,
  safeInvoke: mocks.safeInvoke,
}))

import {
  loadWindowsFileReadMode,
  parseWindowsFileReadMode,
  saveWindowsFileReadMode,
} from './windowsFileReadModeSettings'

describe('windowsFileReadModeSettings', () => {
  beforeEach(() => {
    mocks.loadGlobalSettings.mockReset()
    mocks.saveGlobalSettings.mockReset().mockResolvedValue(undefined)
    mocks.safeInvoke.mockReset().mockResolvedValue(undefined)
  })

  it('defaults invalid values to automatic mode', () => {
    expect(parseWindowsFileReadMode(undefined)).toBe('auto')
    expect(parseWindowsFileReadMode('other')).toBe('auto')
    expect(parseWindowsFileReadMode('auto')).toBe('auto')
    expect(parseWindowsFileReadMode('native')).toBe('native')
  })

  it('loads the setting into the Rust read path', async () => {
    mocks.loadGlobalSettings.mockResolvedValue({ 'files.windowsReadMode': 'native' })

    await expect(loadWindowsFileReadMode()).resolves.toBe('native')
    expect(mocks.safeInvoke).toHaveBeenCalledWith(
      '设置 Windows 文件读取模式',
      'set_text_read_mode',
      { mode: 'native' },
    )
  })

  it('persists and immediately applies a selected mode', async () => {
    mocks.loadGlobalSettings.mockResolvedValue({ custom: { keep: true } })

    await expect(saveWindowsFileReadMode('native')).resolves.toBe('native')
    expect(mocks.saveGlobalSettings).toHaveBeenCalledWith({
      custom: { keep: true },
      'files.windowsReadMode': 'native',
    })
    expect(mocks.safeInvoke).toHaveBeenCalledWith(
      '设置 Windows 文件读取模式',
      'set_text_read_mode',
      { mode: 'native' },
    )
  })
})
