// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

vi.mock('../lib/tauri', () => ({
  safeInvoke: vi.fn(), isTauri: () => true,
  NotInTauriError: class extends Error {},
}))
vi.mock('../lib/excludeSettings', () => ({
  loadExcludeSettingsForProject: vi.fn(async () => ({ filesExclude: [], excludeGitIgnore: false })),
}))
vi.mock('../lib/projectRepository', () => ({}))
vi.mock('./editorSessionBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('./editorSessionBridge')>()),
  activateProjectSession: vi.fn(),
}))
import { safeInvoke } from '../lib/tauri'
import { useProjectStore } from './projectStore'

const initialState = useProjectStore.getState()
const root = mkdtempSync(join(tmpdir(), 'qingcode-tree-refresh-'))
const project: Project = { id: 'refresh', path: root, name: 'refresh', created_at: 0, last_opened_at: 0 }
const folder = join(root, 'docs')
const oldPath = join(folder, 'old.txt')
const newPath = join(folder, 'new.txt')
const scan = (path: string) => readdirSync(path, { withFileTypes: true }).map(entry => ({
  name: entry.name, path: join(path, entry.name), is_dir: entry.isDirectory(), loaded: !entry.isDirectory(),
}))
const childrenNames = () => useProjectStore.getState().projectTrees[project.id]
  .find(n => n.name === 'docs')?.children?.map(n => n.name)

beforeEach(() => {
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder)
  writeFileSync(oldPath, 'old')
  vi.mocked(safeInvoke).mockImplementation(async (_action, command, args) => {
    if (command !== 'scan_directory') throw new Error(`Unexpected command: ${command}`)
    return scan((args as { path: string }).path)
  })
  useProjectStore.setState({ projects: [project], currentProject: project, projectTreeErrors: {}, toasts: [], projectTrees: {
    [project.id]: [{ name: 'docs', path: folder, is_dir: true, loaded: true, children: scan(folder) }],
  } })
})
afterAll(() => {
  useProjectStore.setState(initialState, true)
  rmSync(root, { recursive: true, force: true })
})

describe('project tree refresh with disk changes', () => {
  it('updates files directly under the project root', async () => {
    writeFileSync(join(root, 'root-new.txt'), 'new')
    await useProjectStore.getState().refreshProjectTree(project)
    expect(useProjectStore.getState().projectTrees[project.id].map(n => n.name)).toContain('root-new.txt')
  })
  it('shows an added file inside a loaded folder', async () => {
    writeFileSync(newPath, 'new')
    await useProjectStore.getState().refreshProjectTree(project)
    expect(childrenNames()).toContain('new.txt')
  })
  it('removes a deleted file inside a loaded folder', async () => {
    unlinkSync(oldPath)
    await useProjectStore.getState().refreshProjectTree(project)
    expect(childrenNames()).not.toContain('old.txt')
  })
  it('shows a renamed file inside a loaded folder', async () => {
    renameSync(oldPath, newPath)
    await useProjectStore.getState().refreshProjectTree(project)
    expect(childrenNames()).toEqual(['new.txt'])
  })
  it('forced folder refresh picks up changes', async () => {
    renameSync(oldPath, newPath)
    await useProjectStore.getState().expandProjectDir(project.id, folder, { force: true })
    expect(childrenNames()).toEqual(['new.txt'])
  })
})
