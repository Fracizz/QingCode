import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

// Shared mock state must be hoisted so the vi.mock factories (which run before
// top-level imports) can reference it safely.
const { mockDb, savedSettingsRef, globalSettingsRef } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    execute: vi.fn(),
  },
  savedSettingsRef: { settings: [] as Array<Record<string, unknown>> },
  globalSettingsRef: {
    settings: { version: 1, custom: {} } as Record<string, unknown>,
  },
}))

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => mockDb },
}))

vi.mock('./tauri', () => ({
  isTauri: () => true,
  safeInvoke: vi.fn(async () => 'sqlite:mock'),
  NotInTauriError: class NotInTauriError extends Error {},
}))

vi.mock('./projectSettings', () => ({
  PROJECTS_KEY: 'qingcode.projects',
  loadGlobalSettings: async () => globalSettingsRef.settings,
  saveGlobalSettings: async (s: Record<string, unknown>) => {
    savedSettingsRef.settings.push(s)
  },
  readProjectEntries: () => [],
  shouldSyncProjectsOnStartup: () => true,
}))

import { persistProjectsToUserSettings } from './projectRepository'

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'id-' + Math.random().toString(36).slice(2, 8),
    name: 'proj',
    path: 'D:/proj',
    created_at: 1,
    last_opened_at: 1,
    ...over,
  }
}

describe('persistProjectsToUserSettings', () => {
  beforeEach(() => {
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    savedSettingsRef.settings = []
    globalSettingsRef.settings = { version: 1, custom: {}, 'qingcode.update.checkOnStartup': true }
  })

  it('maps durable projects to portable entries and writes them under qingcode.projects', async () => {
    const rows: Project[] = [
      project({ id: 'a', name: 'Alpha', path: 'D:/alpha', hidden: 1, default_shell: 'pwsh', sort_order: 0, last_opened_at: 200 }),
      project({ id: 'b', name: 'Beta', path: 'D:/beta', hidden: 0, default_shell: undefined, sort_order: 1, last_opened_at: 100 }),
    ]
    mockDb.select.mockResolvedValue(rows)

    await persistProjectsToUserSettings()

    expect(mockDb.select).toHaveBeenCalledWith(
      'SELECT * FROM projects ORDER BY sort_order ASC, last_opened_at DESC',
    )
    expect(savedSettingsRef.settings).toHaveLength(1)
    const saved = savedSettingsRef.settings[0]
    expect(saved['qingcode.projects']).toEqual([
      { path: 'D:/alpha', name: 'Alpha', hidden: true, defaultShell: 'pwsh' },
      { path: 'D:/beta', name: 'Beta' },
    ])
    // Other settings keys are preserved; only qingcode.projects is replaced.
    expect(saved['qingcode.update.checkOnStartup']).toBe(true)
    expect(saved.version).toBe(1)
  })

  it('drops SQLite-only fields (id / created_at / last_opened_at / sort_order)', async () => {
    const rows: Project[] = [
      project({ id: 'x', name: 'X', path: 'D:/x', created_at: 999, last_opened_at: 888, sort_order: 5 }),
    ]
    mockDb.select.mockResolvedValue(rows)

    await persistProjectsToUserSettings()

    const entry = (savedSettingsRef.settings[0]['qingcode.projects'] as Array<Record<string, unknown>>)[0]
    expect(entry).toEqual({ path: 'D:/x', name: 'X' })
    expect(entry).not.toHaveProperty('id')
    expect(entry).not.toHaveProperty('created_at')
    expect(entry).not.toHaveProperty('last_opened_at')
    expect(entry).not.toHaveProperty('sort_order')
  })

  it('omits name / defaultShell when blank and hidden when not 1', async () => {
    const rows: Project[] = [
      project({ name: '   ', path: 'D:/p', hidden: 0, default_shell: '  ' }),
    ]
    mockDb.select.mockResolvedValue(rows)

    await persistProjectsToUserSettings()

    const entry = (savedSettingsRef.settings[0]['qingcode.projects'] as Array<Record<string, unknown>>)[0]
    expect(entry).toEqual({ path: 'D:/p' })
    expect(entry).not.toHaveProperty('name')
    expect(entry).not.toHaveProperty('hidden')
    expect(entry).not.toHaveProperty('defaultShell')
  })

  it('preserves entry order returned by the SQL query', async () => {
    const rows: Project[] = [
      project({ name: 'First', path: 'D:/first' }),
      project({ name: 'Second', path: 'D:/second' }),
      project({ name: 'Third', path: 'D:/third' }),
    ]
    mockDb.select.mockResolvedValue(rows)

    await persistProjectsToUserSettings()

    const entries = savedSettingsRef.settings[0]['qingcode.projects'] as Array<{ name: string }>
    expect(entries.map(e => e.name)).toEqual(['First', 'Second', 'Third'])
  })

  it('writes an empty array when there are no durable projects', async () => {
    mockDb.select.mockResolvedValue([])

    await persistProjectsToUserSettings()

    expect(savedSettingsRef.settings[0]['qingcode.projects']).toEqual([])
  })
})
