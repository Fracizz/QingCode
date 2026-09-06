import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSshConnection: vi.fn(),
  isProjectTrusted: vi.fn(() => true),
  safeInvoke: vi.fn(),
}))

vi.mock('./projectRepository', () => ({ getSshConnection: mocks.getSshConnection }))
vi.mock('./tauri', () => ({ safeInvoke: mocks.safeInvoke }))
vi.mock('./workspaceTrust', () => ({ isProjectTrusted: mocks.isProjectTrusted }))

import {
  ensureSshWorkspaceConnected,
  findSshProject,
  isSshProject,
  normalizeRemotePath,
  parentRemotePath,
  sshConnectionIdFromUri,
  sshConnectionLabel,
  sshProjectDisplayPath,
  sshRemotePathFromUri,
  sshRootUri,
} from './sshWorkspace'
import type { Project, SshConnection } from '../types'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sshRootUri', () => {
  it('builds a stable provider URI from a POSIX root', () => {
    expect(sshRootUri('connection-id', '/Home/User/App/')).toBe('ssh://connection-id/Home/User/App')
  })

  it('normalizes separators without lowercasing Linux paths', () => {
    expect(sshRootUri('connection-id', '\\Home\\User\\Foo.ts')).toBe(
      'ssh://connection-id/Home/User/Foo.ts'
    )
  })

  it('keeps the POSIX root slash', () => {
    expect(sshRootUri('connection-id', '/')).toBe('ssh://connection-id/')
  })
})

describe('sshConnectionLabel', () => {
  it('keeps a custom connection name beside the SSH target', () => {
    expect(
      sshConnectionLabel({
        id: 'c1',
        name: 'WSL',
        host: 'localhost',
        port: 22,
        username: 'owner',
        auth_kind: 'privateKey',
        host_key_fingerprint: 'fp',
        created_at: 1,
        updated_at: 1,
      })
    ).toBe('WSL（owner@localhost）')
  })
})

describe('findSshProject', () => {
  it('matches an existing project on the same connection and remote root', () => {
    const project = {
      id: 'p1',
      name: 'app',
      path: 'ssh://c1/home/owner/app',
      created_at: 1,
      last_opened_at: 1,
      kind: 'ssh' as const,
      connection_id: 'c1',
      root_path: '/home/owner/app',
    }
    expect(findSshProject([project], 'c1', '/home/owner/app/')).toEqual(project)
    expect(findSshProject([project], 'c1', '/home/owner/other')).toBeUndefined()
  })
})

describe('isSshProject', () => {
  it('treats kind or ssh URI as remote', () => {
    expect(isSshProject({ kind: 'ssh', path: 'ssh://c1/root' })).toBe(true)
    expect(isSshProject({ path: 'ssh://c1/root' })).toBe(true)
    expect(isSshProject({ kind: 'local', path: 'D:/code' })).toBe(false)
  })
})

describe('sshProjectDisplayPath', () => {
  it('shows host and remote root instead of the internal URI', () => {
    expect(
      sshProjectDisplayPath(
        { kind: 'ssh', path: 'ssh://c1/root/.claude', root_path: '/root/.claude' },
        { id: 'c1', username: 'root', host: 'localhost', port: 22 }
      )
    ).toBe('root@localhost:/root/.claude')
  })

  it('never surfaces the internal ssh:// connection URI', () => {
    const path = 'ssh://c451183d-a3b4-4c53-ab3c-fae6b3a36630/home/code/ai-auto-test-dev'
    expect(sshConnectionIdFromUri(path)).toBe('c451183d-a3b4-4c53-ab3c-fae6b3a36630')
    expect(sshRemotePathFromUri(path)).toBe('/home/code/ai-auto-test-dev')
    expect(
      sshProjectDisplayPath({ kind: 'ssh', path, root_path: '/home/code/ai-auto-test-dev' })
    ).toBe('/home/code/ai-auto-test-dev')
    expect(
      sshProjectDisplayPath({ kind: 'ssh', path }, null, [
        {
          id: 'c451183d-a3b4-4c53-ab3c-fae6b3a36630',
          username: 'root',
          host: 'localhost',
          port: 22,
        },
      ])
    ).toBe('root@localhost:/home/code/ai-auto-test-dev')
  })
})

describe('parentRemotePath', () => {
  it('walks up POSIX directories without leaving the root', () => {
    expect(parentRemotePath('/root/.claude')).toBe('/root')
    expect(parentRemotePath('/root')).toBe('/')
    expect(parentRemotePath('/')).toBe('/')
  })

  it('normalizes trailing slashes before walking up', () => {
    expect(normalizeRemotePath('/root/')).toBe('/root')
    expect(parentRemotePath('/root/')).toBe('/')
  })
})

describe('ensureSshWorkspaceConnected', () => {
  const connection: SshConnection = {
    id: 'wsl',
    name: 'WSL',
    host: 'localhost',
    port: 22,
    username: 'root',
    auth_kind: 'password',
    host_key_fingerprint: 'SHA256:test',
    created_at: 1,
    updated_at: 1,
  }

  function project(id: string, path: string): Project {
    return {
      id,
      name: 'app',
      path: `ssh://wsl${path}`,
      kind: 'ssh',
      connection_id: 'wsl',
      root_path: path,
      created_at: 1,
      last_opened_at: 1,
    }
  }

  it('registers every full root when same-named projects share one live connection', async () => {
    const registeredRoots = new Set<string>()
    mocks.getSshConnection.mockResolvedValue(connection)
    mocks.safeInvoke.mockImplementation(
      async (_label: string, command: string, args: Record<string, unknown>) => {
        if (command === 'ssh_workspace_status') {
          return registeredRoots.has(args.rootUri as string)
        }
        if (command === 'ssh_connection_status') return true
        if (command === 'ssh_connect') {
          registeredRoots.add(args.rootUri as string)
          return { fingerprint: 'SHA256:test', canonicalRoot: args.rootUri }
        }
        throw new Error(`Unexpected command: ${command}`)
      }
    )

    const first = project('p1', '/home/team/app')
    const second = project('p2', '/work/other/app')
    await Promise.all([ensureSshWorkspaceConnected(first), ensureSshWorkspaceConnected(second)])

    expect(registeredRoots).toEqual(new Set([first.path, second.path]))
    expect(mocks.safeInvoke.mock.calls.filter(call => call[1] === 'ssh_connect')).toHaveLength(2)

    await Promise.all([ensureSshWorkspaceConnected(first), ensureSshWorkspaceConnected(second)])
    expect(mocks.safeInvoke.mock.calls.filter(call => call[1] === 'ssh_connect')).toHaveLength(2)
  })
})
