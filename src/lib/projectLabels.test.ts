import { describe, expect, it } from 'vitest'
import type { Project, SshConnection } from '../types'
import { buildProjectLabels } from './projectLabels'

const connection = (id: string, name: string, host = id): SshConnection => ({
  id,
  name,
  host,
  username: 'dev',
  port: 22,
  auth_kind: 'privateKey',
  host_key_fingerprint: 'fp',
  created_at: 1,
  updated_at: 1,
})
const local = (id: string, path = `/work/${id}/nem-panel`): Project => ({
  id,
  name: 'nem-panel',
  path,
  created_at: 1,
  last_opened_at: 1,
})
const ssh = (id: string, connectionId: string, root = '/work/nem-panel'): Project => ({
  ...local(id),
  kind: 'ssh',
  connection_id: connectionId,
  root_path: root,
  path: `ssh://${connectionId}${root}`,
})
const labels = (projects: Project[], connections: SshConnection[] = []) =>
  buildProjectLabels(projects, connections, '本机')

describe('buildProjectLabels', () => {
  it('keeps unique display names concise, including manually renamed projects', () => {
    const projects = [ssh('a', 'win'), { ...ssh('b', 'wsl'), name: 'nem-panel 开发' }]
    const result = labels(projects)
    expect(result.get('a')?.text).toBe('nem-panel')
    expect(result.get('b')?.source).toBeNull()
    expect(result.get('b')?.text).toBe('nem-panel 开发')
  })

  it('distinguishes WinDev and SSH-connected WSL using saved connection names', () => {
    const projects = [ssh('a', 'win'), ssh('b', 'wsl')]
    const before = structuredClone(projects)
    const result = labels(projects, [connection('win', 'WinDev'), connection('wsl', 'WSL')])
    expect(result.get('a')?.text).toBe('nem-panel [WinDev]')
    expect(result.get('b')?.text).toBe('nem-panel [WSL]')
    expect(projects).toEqual(before)
  })

  it('includes hidden projects and stays stable under sorting or hiding', () => {
    const connections = [connection('win', 'WinDev'), connection('wsl', 'WSL')]
    const projects = [ssh('a', 'win'), ssh('b', 'wsl')]
    const result = labels(projects, connections)
    expect(labels([{ ...projects[1], hidden: 1 }, projects[0]], connections).get('a')).toEqual(
      result.get('a')
    )
  })

  it('adds the shortest distinguishing parent directory for same-host projects', () => {
    const result = labels(
      [ssh('a', 'wsl', '/home/dev/work/nem-panel'), ssh('b', 'wsl', '/home/dev/backup/nem-panel')],
      [connection('wsl', 'WSL')]
    )
    expect(result.get('a')?.source).toBe('WSL · work')
    expect(result.get('b')?.source).toBe('WSL · backup')
  })

  it('expands shared parent names only as far as needed', () => {
    const result = labels([
      local('a', '/work/client/code/nem-panel'),
      local('b', '/work/server/code/nem-panel'),
      local('c', '/backup/nem-panel'),
    ])
    expect(result.get('a')?.source).toBe('本机 · client/code')
    expect(result.get('b')?.source).toBe('本机 · server/code')
    expect(result.get('c')?.source).toBe('本机 · backup')
  })

  it('handles Windows drive paths and trailing separators without filesystem APIs', () => {
    const result = labels([
      local('a', String.raw`C:\code\nem-panel` + '/'),
      local('b', 'D:/code/nem-panel/'),
    ])
    expect(result.get('a')?.source).toBe('本机 · C:/code')
    expect(result.get('b')?.source).toBe('本机 · D:/code')
  })

  it('falls back to the root path when manually named siblings share a parent', () => {
    const result = labels([local('a', '/work/app-one'), local('b', '/work/app-two')])
    expect(result.get('a')?.source).toBe('本机 · /work/app-one')
    expect(result.get('b')?.source).toBe('本机 · /work/app-two')
    expect(labels([local('a', '/'), local('b', '/work')]).get('a')?.source).toBe('本机 · /')
  })

  it('distinguishes local, native WSL distributions, and SSH connections named WSL', () => {
    const projects = [
      local('local'),
      { ...local('ubuntu', 'wsl://Ubuntu/home/dev/nem-panel'), kind: 'wsl' as const },
      { ...local('debian', String.raw`\\wsl$\Debian\home\dev\nem-panel`), kind: 'wsl' as const },
      ssh('ssh', 'wsl'),
    ]
    const result = labels(projects, [connection('wsl', 'WSL', 'localhost')])
    expect(result.get('local')?.source).toBe('本机')
    expect(result.get('ubuntu')?.source).toBe('WSL · Ubuntu')
    expect(result.get('debian')?.source).toBe('WSL · Debian')
    expect(result.get('ssh')?.source).toBe('WSL · dev@localhost')
  })

  it('disambiguates duplicate connection names using accounts and ports', () => {
    const result = labels(
      [ssh('a', 'one'), ssh('b', 'two')],
      [
        connection('one', '开发机', 'server'),
        { ...connection('two', '开发机', 'server'), username: 'root', port: 2222 },
      ]
    )
    expect(result.get('a')?.source).toBe('开发机 · dev@server')
    expect(result.get('b')?.source).toBe('开发机 · root@server:2222')
  })

  it('uses legacy SSH URI fields and missing connection identities as fallbacks', () => {
    const result = labels(
      [{ ...ssh('a', 'one'), connection_id: undefined, root_path: undefined }, ssh('b', 'two')],
      [{ ...connection('one', ''), host: 'server' }]
    )
    expect(result.get('a')?.source).toBe('dev@server')
    expect(result.get('b')?.source).toBe('two')
  })

  it('keeps duplicate records distinguishable without numbering by list position', () => {
    const projects = [local('first', '/work/nem-panel'), local('second', '/work/nem-panel')]
    const forward = labels(projects)
    const reverse = labels([...projects].reverse())
    expect(forward.get('first')?.text).not.toBe(forward.get('second')?.text)
    expect(reverse).toEqual(forward)
  })

  it('detects case and whitespace collisions and localizes the local source', () => {
    const projects = [local('a'), { ...local('b'), name: ' NEM-panel ' }]
    const result = buildProjectLabels(projects, [], 'This PC')
    expect(result.get('a')?.source).toBe('This PC · a')
    expect(result.get('b')?.name).toBe(' NEM-panel ')
  })
})
