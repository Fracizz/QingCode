import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_SESSION_KEY,
  buildWorkspaceSessionSnapshot,
  clearWorkspaceSession,
  collectPersistedTabPaths,
  loadWorkspaceSession,
  parseWorkspaceSession,
  saveWorkspaceSession,
} from './workspaceSessionPersist'

function installMemoryLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  })
}

beforeEach(() => {
  installMemoryLocalStorage()
})

afterEach(() => {
  clearWorkspaceSession()
  vi.unstubAllGlobals()
})

describe('parseWorkspaceSession', () => {
  it('rejects wrong version and non-objects', () => {
    expect(parseWorkspaceSession(null)).toBeNull()
    expect(parseWorkspaceSession({ version: 2, projects: {} })).toBeNull()
  })

  it('keeps valid tabs and terminals', () => {
    const parsed = parseWorkspaceSession({
      version: 1,
      updatedAt: 10,
      projects: {
        p1: {
          tabs: [
            { id: 't1', path: 'D:/a/b.ts', name: 'b.ts', dirty: true, language: 'typescript' },
            { id: 'bad' },
          ],
          activeTabId: 't1',
          terminals: [
            {
              id: 'term1',
              name: '终端 1',
              cwd: 'D:/a',
              launchCommand: '',
              profileId: 'powershell',
            },
          ],
          activeTerminalId: 'term1',
        },
      },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.projects.p1.tabs).toHaveLength(1)
    expect(parsed!.projects.p1.tabs[0].dirty).toBe(true)
    expect(parsed!.projects.p1.terminals[0].profileId).toBe('powershell')
    expect(parsed!.projects.p1.activeTabId).toBe('t1')
  })

  it('drops empty project sessions', () => {
    const parsed = parseWorkspaceSession({
      version: 1,
      updatedAt: 1,
      projects: { empty: { tabs: [], terminals: [], activeTabId: null, activeTerminalId: null } },
    })
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!.projects)).toHaveLength(0)
  })

  it('keeps global pinned settings tabs', () => {
    const parsed = parseWorkspaceSession({
      version: 1,
      updatedAt: 2,
      pinnedTabs: [
        {
          id: 'pin1',
          path: 'C:/Users/x/.qingcode/default-settings.json',
          name: 'default-settings.json',
          dirty: false,
          language: 'json5',
          scroll: { top: 40, left: 0 },
        },
      ],
      projects: {},
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.pinnedTabs).toHaveLength(1)
    expect(parsed!.pinnedTabs![0].scroll).toEqual({ top: 40, left: 0 })
    expect(collectPersistedTabPaths(parsed!)).toEqual([
      'C:/Users/x/.qingcode/default-settings.json',
    ])
  })
})

describe('buildWorkspaceSessionSnapshot', () => {
  it('merges editor sessions and terminals; skips excluded projects', () => {
    const snapshot = buildWorkspaceSessionSnapshot({
      editorSessions: {
        p1: {
          tabs: [
            {
              id: 't1',
              path: 'D:/proj/a.ts',
              name: 'a.ts',
              dirty: false,
              language: 'typescript',
              scroll: { top: 12, left: 0 },
            },
          ],
          activeTabId: 't1',
        },
        ephemeral: {
          tabs: [{ id: 'e1', path: 'D:/tmp/x.ts', name: 'x.ts', dirty: false }],
          activeTabId: 'e1',
        },
      },
      terminals: [
        {
          id: 'term1',
          name: 'PowerShell',
          projectId: 'p1',
          cwd: 'D:/proj',
          launchCommand: '',
          profileId: 'ps',
          allowTitleRename: true,
        },
        {
          id: 'termE',
          name: 'tmp',
          projectId: 'ephemeral',
          cwd: 'D:/tmp',
          launchCommand: '',
        },
      ],
      activeTerminalByProject: { p1: 'term1', ephemeral: 'termE' },
      excludeProjectIds: ['ephemeral'],
      now: 42,
    })

    expect(snapshot.updatedAt).toBe(42)
    expect(snapshot.projects.ephemeral).toBeUndefined()
    expect(snapshot.projects.p1.tabs[0].scroll).toEqual({ top: 12, left: 0 })
    expect(snapshot.projects.p1.terminals).toHaveLength(1)
    expect(snapshot.projects.p1.activeTerminalId).toBe('term1')
    expect(collectPersistedTabPaths(snapshot)).toEqual(['D:/proj/a.ts'])
  })

  it('includes pinned settings tabs at the workspace root', () => {
    const snapshot = buildWorkspaceSessionSnapshot({
      editorSessions: {},
      pinnedTabs: [
        {
          id: 'pin1',
          path: 'C:/Users/x/.qingcode/default-settings.json',
          name: 'default-settings.json',
          dirty: false,
          language: 'json5',
        },
      ],
      terminals: [],
      activeTerminalByProject: {},
      now: 7,
    })
    expect(snapshot.pinnedTabs).toHaveLength(1)
    expect(snapshot.pinnedTabs![0].path).toContain('default-settings.json')
  })
})

describe('localStorage roundtrip', () => {
  it('save/load preserves snapshot', () => {
    const snapshot = buildWorkspaceSessionSnapshot({
      editorSessions: {
        p1: {
          tabs: [{ id: 't1', path: 'D:/a.ts', name: 'a.ts', dirty: true }],
          activeTabId: 't1',
        },
      },
      terminals: [
        {
          id: 'term1',
          name: '终端 1',
          projectId: 'p1',
          cwd: 'D:/',
          launchCommand: 'echo hi',
          shellKind: 'command',
        },
      ],
      activeTerminalByProject: { p1: 'term1' },
      now: 99,
    })

    saveWorkspaceSession(snapshot)
    expect(localStorage.getItem(WORKSPACE_SESSION_KEY)).toBeTruthy()
    expect(loadWorkspaceSession()).toEqual(snapshot)
  })
})
