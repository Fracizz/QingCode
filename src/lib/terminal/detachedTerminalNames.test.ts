// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { NAMED_WORKSPACES_KEY } from '../namedWorkspacePersist'
import { terminalFromPersisted } from '../workspaceSessionRestore'
import { terminalNameForReattach } from './detachedTerminalNames'

afterEach(() => localStorage.clear())

it('repairs an already attached UUID label only from a record of that exact original terminal', () => {
  const original = 'f5c652c2-be54-499e-af22-4b480d42a190'
  const meta = {
    id: 'new-tab', name: original, cwd: 'ssh://c/app', connectionId: 'c',
    persistent: true, ptyId: 'live', launchCommand: '',
  }
  const snapshot = (name: string, updatedAt: number, overrides: object = {}) => ({
    id: name, name, updatedAt, members: [{ projectId: 'p', path: meta.cwd }],
    sessions: { p: { tabs: [], terminals: [{ ...meta, id: original, name, ...overrides }] } },
  })
  localStorage.setItem(NAMED_WORKSPACES_KEY, JSON.stringify({ version: 1, workspaces: [
    snapshot('过时标题', 1), snapshot('django · worker', 2), snapshot('另一次运行', 3, { ptyId: 'dead' }),
    snapshot('另一台机器', 4, { connectionId: 'd', cwd: 'ssh://d/app' }),
  ] }))
  expect(terminalFromPersisted('p', meta).name).toBe('django · worker')
  expect(terminalNameForReattach('p', [])({ ...meta, name: undefined, originalTabId: original })).toBe('django · worker')
  expect(terminalFromPersisted('p', { ...meta, name: '我的新标题' }).name).toBe('我的新标题')
  expect(terminalNameForReattach('another-project', [])({ ...meta, name: undefined, originalTabId: original })).toBeUndefined()
})
