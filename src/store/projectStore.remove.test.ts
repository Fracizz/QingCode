// @vitest-environment jsdom

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  settings: {} as Record<string, unknown>,
}))

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (sql: string, params: string[] = []) =>
        state.db!.prepare(sql.replace(/\$\d+/g, '?')).all(...params),
      execute: async (sql: string, params: (string | number | null)[] = []) => {
        const result = state.db!.prepare(sql.replace(/\$\d+/g, '?')).run(...params)
        return { rowsAffected: result.changes }
      },
    }),
  },
}))
vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: vi.fn(async () => 'sqlite:removal-test'),
  NotInTauriError: class NotInTauriError extends Error {},
}))
vi.mock('../lib/projectSettings', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/projectSettings')>()),
  PROJECTS_KEY: 'qingcode.projects',
  loadGlobalSettings: async () => structuredClone(state.settings),
  saveGlobalSettings: async (settings: Record<string, unknown>) => {
    state.settings = structuredClone(settings)
  },
  readProjectEntries: (settings: Record<string, unknown>) => settings['qingcode.projects'] ?? [],
  shouldSyncProjectsOnStartup: () => true,
}))
vi.mock('../lib/workspaceTrust', () => ({
  ensureWorkspaceTrust: vi.fn(async () => 'trusted'),
  pushTrustedRootsToNative: vi.fn(),
}))
vi.mock('../lib/pathAllowlist', () => ({
  syncRootsFromProjects: vi.fn(),
}))
vi.mock('../lib/windowSession', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/windowSession')>()),
  shouldRestoreWorkspace: () => false,
}))
vi.mock('./editorSessionBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('./editorSessionBridge')>()),
  activateProjectSession: vi.fn(),
}))

import { useProjectStore } from './projectStore'
import { loadProjectsFromDb } from '../lib/projectRepository'

const initialState = useProjectStore.getState()
const projects: Project[] = [
  {
    id: 'removed',
    name: 'Remove me',
    path: 'D:/remove-me',
    hidden: 1,
    created_at: 1,
    last_opened_at: 1,
  },
  { id: 'kept', name: 'Keep me', path: 'D:/keep-me', hidden: 0, created_at: 2, last_opened_at: 2 },
]

beforeEach(() => {
  state.db = new DatabaseSync(':memory:')
  state.db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT UNIQUE,
      hidden INTEGER, created_at INTEGER, last_opened_at INTEGER, sort_order INTEGER DEFAULT 0,
      kind TEXT DEFAULT 'local', default_shell TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('legacy_my_code_desktop_db_v1', 'done');
    CREATE TABLE recent_files (project_id TEXT, path TEXT, opened_at INTEGER);
    CREATE TABLE favorite_items (project_id TEXT, path TEXT);
    CREATE TABLE ssh_connections (id TEXT, name TEXT);
    INSERT INTO recent_files VALUES ('removed', 'D:/remove-me/keep.txt', 1);
    INSERT INTO favorite_items VALUES ('removed', 'D:/remove-me/keep.txt');
  `)
  for (const project of projects) {
    state.db
      .prepare(
        'INSERT INTO projects (id, name, path, hidden, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.hidden!,
        project.created_at,
        project.last_opened_at
      )
  }
  state.settings = {
    'qingcode.projects': projects.map(project => ({
      path: project.path,
      name: project.name,
      hidden: !!project.hidden,
    })),
    'qingcode.update.checkOnStartup': false,
  }
  useProjectStore.setState(
    {
      ...initialState,
      projects,
      currentProject: projects[1],
      projectTrees: { removed: [], kept: [] },
      expandedProjects: { removed: true, kept: true },
      toasts: [],
    },
    true
  )
})

afterEach(() => {
  state.db?.close()
  useProjectStore.setState(initialState, true)
})

describe('project removal with settings startup sync enabled', () => {
  it('removes the SQLite record and portable seed without reimporting it on reload', async () => {
    await useProjectStore.getState().removeProject('removed')
    expect(useProjectStore.getState().projects.map(project => project.id)).toEqual(['kept'])
    expect(useProjectStore.getState().currentProject?.id).toBe('kept')
    expect(useProjectStore.getState().projectTrees).not.toHaveProperty('removed')
    expect(useProjectStore.getState().expandedProjects).not.toHaveProperty('removed')
    expect(state.db!.prepare('SELECT * FROM recent_files').all()).toEqual([])
    expect(state.db!.prepare('SELECT * FROM favorite_items').all()).toEqual([])
    expect(state.settings['qingcode.projects']).toEqual([{ path: 'D:/keep-me', name: 'Keep me' }])
    expect(state.settings['qingcode.update.checkOnStartup']).toBe(false)
    await useProjectStore.getState().loadProjects()
    expect(useProjectStore.getState().projects.map(project => project.id)).toEqual(['kept'])
  })

  it('does not import a stale seed during a database-only reload', async () => {
    state.db!.prepare('DELETE FROM projects WHERE id = ?').run('removed')
    const loaded = await loadProjectsFromDb({ syncFromSettings: false })
    expect(loaded.importedFromSettings).toBe(0)
    expect(loaded.projects.map(project => project.id)).toEqual(['kept'])
    // The default startup path still imports user settings normally.
    const startup = await loadProjectsFromDb()
    expect(startup.importedFromSettings).toBe(1)
    expect(startup.projects.some(project => project.path === 'D:/remove-me')).toBe(true)
  })

  it('can remove every project without the startup seed restoring any of them', async () => {
    for (const project of projects) await useProjectStore.getState().removeProject(project.id)
    await useProjectStore.getState().loadProjects()
    expect(useProjectStore.getState().projects).toEqual([])
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(state.settings['qingcode.projects']).toEqual([])
  })
})
