// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  loadGlobalSettings: vi.fn(),
  loadProjectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
  settingsFileExists: vi.fn(),
  resolveProjectSettingsPath: vi.fn(async () => 'D:/alpha/.qingcode/project-settings.json'),
}))

vi.mock('./projectSettings', async () => {
  const actual = await vi.importActual<typeof import('./projectSettings')>('./projectSettings')
  return {
    ...actual,
    loadGlobalSettings: mocks.loadGlobalSettings,
    loadProjectSettings: mocks.loadProjectSettings,
    saveProjectSettings: mocks.saveProjectSettings,
    settingsFileExists: mocks.settingsFileExists,
    resolveProjectSettingsPath: mocks.resolveProjectSettingsPath,
  }
})

import {
  loadEffectiveAutoSaveSettings,
  mergeSettings,
  migrateLegacyProjectAutoSaveDefaults,
} from './autoSaveSettings'
import { DEFAULT_GLOBAL_SETTINGS_TEXT, DEFAULT_PROJECT_SETTINGS_TEXT } from './projectSettings'

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  path: 'D:/alpha',
  created_at: 1,
  last_opened_at: 1,
  hidden: 0,
}

describe('autoSaveSettings', () => {
  beforeEach(() => {
    mocks.loadGlobalSettings.mockReset()
    mocks.loadProjectSettings.mockReset()
    mocks.saveProjectSettings.mockReset()
    mocks.settingsFileExists.mockReset()
    localStorage.clear()
  })

  it('keeps user afterDelay when the workspace settings file is missing', async () => {
    mocks.loadGlobalSettings.mockResolvedValue({
      version: 1,
      custom: {},
      'files.autoSave': 'afterDelay',
      'files.autoSaveDelay': 1000,
    })
    mocks.settingsFileExists.mockResolvedValue(false)

    await expect(loadEffectiveAutoSaveSettings(project)).resolves.toEqual({
      mode: 'afterDelay',
      delay: 1000,
    })
    expect(mocks.loadProjectSettings).not.toHaveBeenCalled()
  })

  it('lets an explicit workspace auto-save override the user setting', async () => {
    mocks.loadGlobalSettings.mockResolvedValue({
      version: 1,
      custom: {},
      'files.autoSave': 'afterDelay',
      'files.autoSaveDelay': 1000,
    })
    mocks.settingsFileExists.mockResolvedValue(true)
    mocks.loadProjectSettings.mockResolvedValue({
      version: 1,
      custom: {},
      'files.autoSave': 'onFocusChange',
    })

    await expect(loadEffectiveAutoSaveSettings(project)).resolves.toEqual({
      mode: 'onFocusChange',
      delay: 1000,
    })
  })

  it('strips legacy template files.autoSave=off from workspace settings once', async () => {
    mocks.settingsFileExists.mockResolvedValue(true)
    mocks.loadProjectSettings.mockResolvedValue({
      version: 1,
      custom: {},
      'files.autoSave': 'off',
      'files.autoSaveDelay': 1000,
      'editor.fontSize': 16,
    })
    mocks.saveProjectSettings.mockResolvedValue(undefined)

    await expect(migrateLegacyProjectAutoSaveDefaults(project)).resolves.toBe(true)
    expect(mocks.saveProjectSettings).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        'editor.fontSize': 16,
      }),
    )
    const saved = mocks.saveProjectSettings.mock.calls[0][1] as Record<string, unknown>
    expect(saved['files.autoSave']).toBeUndefined()
    expect(saved['files.autoSaveDelay']).toBeUndefined()

    // Second call is a no-op for the same project.
    await expect(migrateLegacyProjectAutoSaveDefaults(project)).resolves.toBe(false)
  })

  it('does not invent workspace auto-save when merging an empty overlay', () => {
    const merged = mergeSettings(
      {
        version: 1,
        custom: {},
        'files.autoSave': 'afterDelay',
        'files.autoSaveDelay': 2000,
      },
      { version: 1, custom: {} },
    )
    expect(merged['files.autoSave']).toBe('afterDelay')
    expect(merged['files.autoSaveDelay']).toBe(2000)
  })

  it('keeps auto-save keys in the global template and commented in the project template', () => {
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('"files.autoSave": "off"')
    expect(DEFAULT_PROJECT_SETTINGS_TEXT).toContain('默认继承用户设置')
    expect(DEFAULT_PROJECT_SETTINGS_TEXT).toMatch(/\/\/\s*"files\.autoSave": "off"/)
    expect(DEFAULT_PROJECT_SETTINGS_TEXT).not.toMatch(/^\s*"files\.autoSave":/m)
  })
})
