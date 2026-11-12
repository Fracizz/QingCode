import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types'
const mocks = vi.hoisted(() => ({ global: vi.fn(), workspace: vi.fn(), saveGlobal: vi.fn(), saveWorkspace: vi.fn() }))
vi.mock('@/lib/projectSettings', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/projectSettings')>(),
  loadGlobalSettings: mocks.global, loadProjectSettings: mocks.workspace,
  saveGlobalSettings: mocks.saveGlobal, saveProjectSettings: mocks.saveWorkspace,
}))
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS_TEXT, parseSettingsText } from '@/lib/projectSettings'
import {
  TERMINAL_PASTE_RETENTION_KEY as key, parseTerminalPasteRetentionDays,
  loadScopedTerminalPasteRetentionDays, saveScopedTerminalPasteRetentionDays,
} from './terminalPasteCleanupSettings'

const project: Project = { id: 'p', name: 'app', path: '/app', created_at: 1, last_opened_at: 1 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.global.mockResolvedValue({ ...DEFAULT_GLOBAL_SETTINGS, [key]: 7 })
  mocks.workspace.mockResolvedValue({ version: 1, custom: {} })
})

describe('paste retention settings', () => {
  it('defaults to off, accepts only supported numeric days and preserves inheritance in templates', () => {
    expect(DEFAULT_GLOBAL_SETTINGS[key]).toBe(0)
    for (const value of [undefined, null, true, '7', -1, 1, 365]) expect(parseTerminalPasteRetentionDays(value)).toBe(0)
    for (const days of [7, 15, 30]) expect(parseTerminalPasteRetentionDays(days)).toBe(days)
    expect(parseSettingsText(DEFAULT_PROJECT_SETTINGS_TEXT, 'project')[key]).toBeUndefined()
  })
  it('inherits global retention and permits explicitly disabling it in a workspace', async () => {
    expect(await loadScopedTerminalPasteRetentionDays('project', project)).toBe(7)
    mocks.workspace.mockResolvedValue({ version: 1, custom: {}, [key]: 0 })
    expect(await loadScopedTerminalPasteRetentionDays('project', project)).toBe(0)
  })
  it('saves to the selected scope without scheduling cleanup', async () => {
    await saveScopedTerminalPasteRetentionDays('project', 15, project)
    expect(mocks.saveWorkspace).toHaveBeenCalledWith(project, expect.objectContaining({ [key]: 15 }))
    expect(mocks.saveGlobal).not.toHaveBeenCalled()
    await saveScopedTerminalPasteRetentionDays('global', 30)
    expect(mocks.saveGlobal).toHaveBeenCalledWith(expect.objectContaining({ [key]: 30 }))
  })
})
