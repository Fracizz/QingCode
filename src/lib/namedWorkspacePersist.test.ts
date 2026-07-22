import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NAMED_WORKSPACE_NAME,
  NAMED_WORKSPACES_KEY,
  buildNamedWorkspace,
  clearNamedWorkspaceCatalog,
  emptyNamedWorkspaceCatalog,
  formatNamedWorkspaceName,
  loadNamedWorkspaceCatalog,
  normalizeNamedWorkspaceName,
  parseNamedWorkspace,
  parseNamedWorkspaceCatalog,
  planTitleBarVisibilityUpdates,
  remapWorkspaceSessions,
  removeNamedWorkspace,
  resolveWorkspaceMember,
  saveNamedWorkspaceCatalog,
  setActiveNamedWorkspaceId,
  upsertNamedWorkspace,
} from './namedWorkspacePersist'
import { translateFor } from './i18n'
import type { WorkspaceSessionSnapshot } from './workspaceSessionPersist'

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
  clearNamedWorkspaceCatalog()
  vi.unstubAllGlobals()
})

const sampleSnapshot = (): WorkspaceSessionSnapshot => ({
  version: 1,
  updatedAt: 10,
  projects: {
    p1: {
      tabs: [{ id: 't1', path: 'D:/fe/a.ts', name: 'a.ts', dirty: false }],
      activeTabId: 't1',
      terminals: [
        { id: 'term1', name: '终端 1', cwd: 'D:/fe', launchCommand: '' },
      ],
      activeTerminalId: 'term1',
    },
    p2: {
      tabs: [{ id: 't2', path: 'D:/be/main.rs', name: 'main.rs', dirty: true }],
      activeTabId: 't2',
      terminals: [],
      activeTerminalId: null,
    },
  },
})

describe('parseNamedWorkspace', () => {
  it('rejects empty members and bad shapes', () => {
    expect(parseNamedWorkspace(null)).toBeNull()
    expect(
      parseNamedWorkspace({
        id: 'w1',
        name: 'Full stack',
        members: [],
        sessions: {},
      }),
    ).toBeNull()
  })

  it('keeps members and only sessions for those members', () => {
    const parsed = parseNamedWorkspace({
      id: 'w1',
      name: '  Full stack  ',
      createdAt: 1,
      updatedAt: 2,
      activeProjectId: 'p1',
      members: [
        { projectId: 'p1', path: 'D:/fe', name: 'frontend' },
        { projectId: 'p2', path: 'D:/be', name: 'backend' },
      ],
      sessions: {
        p1: sampleSnapshot().projects.p1,
        orphan: sampleSnapshot().projects.p2,
      },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('Full stack')
    expect(parsed!.members).toHaveLength(2)
    expect(parsed!.sessions.p1).toBeTruthy()
    expect(parsed!.sessions.orphan).toBeUndefined()
    expect(parsed!.activeProjectId).toBe('p1')
  })
})

describe('planTitleBarVisibilityUpdates', () => {
  it('hides non-members and unhides members', () => {
    const updates = planTitleBarVisibilityUpdates(
      [
        { id: 'a', path: 'D:/a', name: 'a', hidden: 0 },
        { id: 'b', path: 'D:/b', name: 'b', hidden: 1 },
        { id: 'c', path: 'D:/c', name: 'c', hidden: 0 },
        { id: 'tmp', path: 'D:/tmp', name: 'tmp', ephemeral: true, hidden: 0 },
      ],
      ['b', 'c'],
    )
    expect(updates).toEqual([
      { id: 'a', hidden: 1, ephemeral: false },
      { id: 'b', hidden: 0, ephemeral: false },
      { id: 'tmp', hidden: 1, ephemeral: true },
    ])
  })

  it('returns empty when already aligned', () => {
    expect(
      planTitleBarVisibilityUpdates(
        [
          { id: 'a', path: 'D:/a', name: 'a', hidden: 0 },
          { id: 'b', path: 'D:/b', name: 'b', hidden: 1 },
        ],
        ['a'],
      ),
    ).toEqual([])
  })
})

describe('buildNamedWorkspace / remapWorkspaceSessions', () => {
  it('builds a workspace from projects + snapshot', () => {
    const ws = buildNamedWorkspace({
      id: 'w1',
      name: 'App',
      projects: [
        { id: 'p1', path: 'D:/fe', name: 'frontend' },
        { id: 'p2', path: 'D:/be', name: 'backend' },
        { id: 'tmp', path: 'D:/tmp', name: 'scratch', ephemeral: true },
      ],
      snapshot: sampleSnapshot(),
      activeProjectId: 'p2',
      now: 99,
    })
    expect(ws).not.toBeNull()
    expect(ws!.members.map(m => m.projectId)).toEqual(['p1', 'p2'])
    expect(ws!.sessions.p1.tabs[0].path).toBe('D:/fe/a.ts')
    expect(ws!.sessions.p2.tabs[0].dirty).toBe(true)
    expect(ws!.activeProjectId).toBe('p2')
    expect(ws!.updatedAt).toBe(99)
  })

  it('resolves members by path when project id changed', () => {
    const member = { projectId: 'old-id', path: 'D:/fe', name: 'frontend' }
    const live = resolveWorkspaceMember(member, [
      { id: 'new-id', path: 'D:\\fe\\', name: 'frontend' },
    ])
    expect(live?.id).toBe('new-id')

    const ws = buildNamedWorkspace({
      name: 'App',
      projects: [{ id: 'old-id', path: 'D:/fe', name: 'frontend' }],
      snapshot: {
        version: 1,
        updatedAt: 1,
        projects: {
          'old-id': sampleSnapshot().projects.p1,
        },
      },
      activeProjectId: 'old-id',
      now: 1,
    })!
    const remapped = remapWorkspaceSessions(ws, [
      { id: 'new-id', path: 'D:/fe', name: 'frontend' },
    ])
    expect(remapped.missing).toHaveLength(0)
    expect(remapped.activeProjectId).toBe('new-id')
    expect(remapped.sessionsByProjectId['new-id'].tabs[0].id).toBe('t1')
  })

  it('reports missing members', () => {
    const ws = buildNamedWorkspace({
      name: 'App',
      projects: [
        { id: 'p1', path: 'D:/fe', name: 'frontend' },
        { id: 'p2', path: 'D:/be', name: 'backend' },
      ],
      snapshot: sampleSnapshot(),
      now: 1,
    })!
    const remapped = remapWorkspaceSessions(ws, [
      { id: 'p1', path: 'D:/fe', name: 'frontend' },
    ])
    expect(remapped.resolved).toHaveLength(1)
    expect(remapped.missing.map(m => m.projectId)).toEqual(['p2'])
  })
})

describe('catalog helpers + localStorage', () => {
  it('upsert / remove / active id roundtrip', () => {
    let catalog = emptyNamedWorkspaceCatalog(1)
    const ws = buildNamedWorkspace({
      id: 'w1',
      name: 'App',
      projects: [{ id: 'p1', path: 'D:/fe', name: 'frontend' }],
      snapshot: {
        version: 1,
        updatedAt: 1,
        projects: { p1: sampleSnapshot().projects.p1 },
      },
      now: 2,
    })!
    catalog = upsertNamedWorkspace(catalog, ws, 3)
    catalog = setActiveNamedWorkspaceId(catalog, 'w1', 4)
    expect(catalog.workspaces).toHaveLength(1)
    expect(catalog.activeWorkspaceId).toBe('w1')

    saveNamedWorkspaceCatalog(catalog)
    expect(localStorage.getItem(NAMED_WORKSPACES_KEY)).toBeTruthy()
    expect(loadNamedWorkspaceCatalog().workspaces[0].name).toBe('App')

    catalog = removeNamedWorkspace(catalog, 'w1', 5)
    expect(catalog.workspaces).toHaveLength(0)
    expect(catalog.activeWorkspaceId).toBeNull()
  })

  it('parseNamedWorkspaceCatalog rejects wrong version', () => {
    expect(parseNamedWorkspaceCatalog({ version: 2, workspaces: [] })).toBeNull()
  })

  it('normalizes and displays the default workspace name across locales', () => {
    expect(normalizeNamedWorkspaceName('Multi-Project Workspace')).toBe(
      DEFAULT_NAMED_WORKSPACE_NAME,
    )
    expect(normalizeNamedWorkspaceName(DEFAULT_NAMED_WORKSPACE_NAME)).toBe(
      DEFAULT_NAMED_WORKSPACE_NAME,
    )
    expect(normalizeNamedWorkspaceName('My stack')).toBe('My stack')

    const tEn = (source: string) => translateFor('en', source)
    const tZh = (source: string) => translateFor('zh-CN', source)
    expect(formatNamedWorkspaceName(DEFAULT_NAMED_WORKSPACE_NAME, tEn)).toBe(
      'Multi-Project Workspace',
    )
    expect(formatNamedWorkspaceName('Multi-Project Workspace', tZh)).toBe(
      DEFAULT_NAMED_WORKSPACE_NAME,
    )
    expect(formatNamedWorkspaceName('My stack', tEn)).toBe('My stack')
  })
})
