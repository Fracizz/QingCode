import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllDrafts, getDraft, persistDraft } from './draftRecovery'
import {
  projectSessionFromPersisted,
  tabFromPersisted,
  terminalFromPersisted,
} from './workspaceSessionRestore'

function installMemoryLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
  })
}

beforeEach(installMemoryLocalStorage)

afterEach(() => {
  clearAllDrafts()
  vi.unstubAllGlobals()
})

describe('workspace session restore journey', () => {
  it('restores and consumes a dirty draft body', () => {
    const path = 'D:/project/src/draft.ts'
    persistDraft(path, 'unsaved buffer', 'p1')

    expect(
      tabFromPersisted({ id: 'draft', path, name: 'draft.ts', dirty: true }),
    ).toMatchObject({
      id: 'draft',
      content: 'unsaved buffer',
      dirty: true,
      language: 'typescript',
      viewMode: 'edit',
    })
    expect(getDraft(path)).toBeNull()
  })

  it('does not invent unsaved content when dirty metadata has no draft', () => {
    const restored = tabFromPersisted({
      id: 'missing-draft',
      path: 'D:/project/src/missing.ts',
      name: 'missing.ts',
      dirty: true,
    })
    expect(restored.dirty).toBe(false)
    expect(restored.content).toBeUndefined()
  })

  it('filters global settings from project tabs and keeps terminal run linkage', () => {
    const session = {
      tabs: [
        {
          id: 'settings',
          path: 'C:/Users/tester/.qingcode/default-settings.json',
          name: 'default-settings.json',
          dirty: false,
        },
        { id: 'file', path: 'D:/project/a.ts', name: 'a.ts', dirty: false },
      ],
      activeTabId: 'settings',
      terminals: [
        {
          id: 'run',
          name: 'dev · web',
          cwd: 'D:/project',
          launchCommand: 'pnpm dev',
          shellKind: 'command' as const,
          runConfigId: 'dev',
          runTaskId: 'web',
        },
      ],
      activeTerminalId: 'run',
    }

    const editor = projectSessionFromPersisted(session)
    expect(editor.tabs.map(tab => tab.id)).toEqual(['file'])
    expect(editor.activeTabId).toBe('file')
    expect(terminalFromPersisted('p1', session.terminals[0])).toMatchObject({
      id: 'run',
      projectId: 'p1',
      runConfigId: 'dev',
      runTaskId: 'web',
      awaitingRestoreSpawn: true,
      status: 'exited',
    })
  })
})
