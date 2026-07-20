import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const settings = vi.hoisted(() => ({
  global: {} as Record<string, unknown>,
  project: {} as Record<string, unknown>,
  saveGlobal: vi.fn(),
  saveProject: vi.fn(),
}))

vi.mock('./autoSaveSettings', () => ({
  mergeSettings: (
    global: Record<string, unknown>,
    workspace?: Record<string, unknown> | null,
  ) => ({ ...global, ...(workspace ?? {}) }),
}))

vi.mock('./projectSettings', () => ({
  DEFAULT_GLOBAL_SETTINGS: { 'editor.minimap.enabled': true },
  loadGlobalSettings: vi.fn(async () => ({ ...settings.global })),
  loadProjectSettings: vi.fn(async () => ({ ...settings.project })),
  saveGlobalSettings: async (next: Record<string, unknown>) => {
    settings.global = { ...next }
    settings.saveGlobal(next)
  },
  saveProjectSettings: async (_project: Project, next: Record<string, unknown>) => {
    settings.project = { ...next }
    settings.saveProject(next)
  },
  parseSettingsText: vi.fn(),
  resolveGlobalSettingsPath: vi.fn(),
  resolveProjectSettingsPath: vi.fn(),
  settingsFileExists: vi.fn(),
}))

vi.mock('./tauri', () => ({ safeInvoke: vi.fn() }))

import {
  getMinimapEnabled,
  loadEffectiveMinimapEnabled,
  saveScopedMinimapEnabled,
} from './minimapSettings'

const project: Project = {
  id: 'p1',
  name: 'project',
  path: 'D:/project',
  created_at: 1,
  last_opened_at: 1,
}

describe('scoped settings persistence journey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.global = {
      'editor.minimap.enabled': true,
      'files.encoding': 'utf8',
    }
    settings.project = {
      'editor.minimap.enabled': false,
      'files.autoSave': 'afterDelay',
    }
  })

  it('persists each scope, preserves adjacent keys, and reloads the effective value', async () => {
    expect(await loadEffectiveMinimapEnabled(project)).toBe(false)

    await saveScopedMinimapEnabled('global', false, project)
    expect(settings.saveGlobal).toHaveBeenCalledWith({
      'editor.minimap.enabled': false,
      'files.encoding': 'utf8',
    })
    expect(getMinimapEnabled()).toBe(false)

    await saveScopedMinimapEnabled('project', true, project)
    expect(settings.saveProject).toHaveBeenCalledWith({
      'editor.minimap.enabled': true,
      'files.autoSave': 'afterDelay',
    })
    expect(getMinimapEnabled()).toBe(true)
  })
})
