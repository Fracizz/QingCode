import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSshConnection: vi.fn(),
  upsertSshConnection: vi.fn(),
  getSshServerEnabled: vi.fn(() => true),
  isProjectTrusted: vi.fn(() => true),
  safeInvoke: vi.fn(),
  currentProject: null as unknown,
  refreshProjectTree: vi.fn(),
}))

vi.mock('./projectRepository', () => ({
  getSshConnection: mocks.getSshConnection,
  upsertSshConnection: mocks.upsertSshConnection,
}))
vi.mock('./sshServerSettings', () => ({ getSshServerEnabled: mocks.getSshServerEnabled }))
vi.mock('./tauri', () => ({ safeInvoke: mocks.safeInvoke }))
vi.mock('./workspaceTrust', () => ({ isProjectTrusted: mocks.isProjectTrusted }))
vi.mock('../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: mocks.currentProject,
      refreshProjectTree: mocks.refreshProjectTree,
    }),
  },
}))

import {
  ensureSshWorkspaceConnected,
  findSshProject,
  isSshProject,
  joinSshResource,
  normalizeRemotePath,
  parentRemotePath,
  resolveSshConnectionMode,
  sshConnectionIdFromUri,
  sshConnectionLabel,
  sshFileDisplayPath,
  sshProjectDisplayPath,
  sshRemotePathFromUri,
  sshRootUri,
  switchSshConnectionMode,
} from './sshWorkspace'
import type { Project, SshConnection } from '../types'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSshServerEnabled.mockReturnValue(true)
  mocks.upsertSshConnection.mockResolvedValue(undefined)
  mocks.currentProject = null
  mocks.refreshProjectTree.mockResolvedValue(undefined)
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

describe('joinSshResource', () => {
  it('appends POSIX segments without rewriting the connection id', () => {
    expect(joinSshResource('ssh://c1/home/owner/app', '.qingcode', 'terminal-paste')).toBe(
      'ssh://c1/home/owner/app/.qingcode/terminal-paste'
    )
  })

  it('joins onto a connection root URI', () => {
    expect(joinSshResource('ssh://c1/', '.qingcode')).toBe('ssh://c1/.qingcode')
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

describe('sshFileDisplayPath', () => {
  it('prefixes the connection label instead of the internal id for file URIs', () => {
    const path = 'ssh://23a6efe9-51bb-4121-9d8a-0b1c2d3e4f5f/D:/code/qingcode/DESIGN.md'
    expect(
      sshFileDisplayPath(path, [
        {
          id: '23a6efe9-51bb-4121-9d8a-0b1c2d3e4f5f',
          name: 'WinDev',
          username: 'administrator',
          host: '192.168.252.107',
          port: 28822,
        },
      ])
    ).toBe('WinDev（administrator@192.168.252.107:28822）:/D:/code/qingcode/DESIGN.md')
  })

  it('falls back to the bare remote path when the connection is unknown', () => {
    expect(sshFileDisplayPath('ssh://gone/home/app/README.md')).toBe('/home/app/README.md')
  })

  it('leaves local paths untouched', () => {
    expect(sshFileDisplayPath('D:\\Code\\QingCode\\DESIGN.md')).toBe(
      'D:\\Code\\QingCode\\DESIGN.md'
    )
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

describe('resolveSshConnectionMode', () => {
  it('keeps valid modes and falls back to the global default', () => {
    expect(resolveSshConnectionMode({ mode: 'server' }, false)).toBe('server')
    expect(resolveSshConnectionMode({ mode: 'ssh' }, true)).toBe('ssh')
    expect(resolveSshConnectionMode({ mode: null }, true)).toBe('server')
    expect(resolveSshConnectionMode({}, false)).toBe('ssh')
    expect(
      resolveSshConnectionMode({ mode: 'foo' as unknown as 'server' }, true)
    ).toBe('server')
  })
})

describe('connectSshWorkspace mode backfill', () => {
  const base: SshConnection = {
    id: 'c1',
    name: 'WSL',
    host: 'localhost',
    port: 22,
    username: 'root',
    auth_kind: 'privateKey',
    host_key_fingerprint: 'SHA256:test',
    created_at: 1,
    updated_at: 1,
    mode: null,
  }
  const project: Project = {
    id: 'p1',
    name: 'app',
    path: 'ssh://c1/home/app',
    kind: 'ssh',
    connection_id: 'c1',
    root_path: '/home/app',
    created_at: 1,
    last_opened_at: 1,
  }

  function mockConnect() {
    mocks.safeInvoke.mockImplementation(
      async (_label: string, command: string, args: Record<string, unknown>) => {
        if (command === 'ssh_workspace_status') return false
        if (command === 'ssh_connection_status') return true
        if (command === 'ssh_connect') return { fingerprint: 'SHA256:test' }
        throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`)
      }
    )
  }

  it('writes the resolved mode back once and uses it for the session', async () => {
    mockConnect()
    mocks.getSshConnection.mockResolvedValue({ ...base })
    mocks.getSshServerEnabled.mockReturnValue(false)

    await ensureSshWorkspaceConnected(project)

    expect(mocks.upsertSshConnection).toHaveBeenCalledTimes(1)
    expect(mocks.upsertSshConnection).toHaveBeenCalledWith({ ...base, mode: 'ssh' })
    const connect = mocks.safeInvoke.mock.calls.find(call => call[1] === 'ssh_connect')
    expect((connect?.[2] as { config: { mode: string } }).config.mode).toBe('ssh')
  })

  it('does not rewrite an existing valid mode', async () => {
    mockConnect()
    mocks.getSshConnection.mockResolvedValue({ ...base, mode: 'server' })

    await ensureSshWorkspaceConnected(project)

    expect(mocks.upsertSshConnection).not.toHaveBeenCalled()
  })

  it('still connects when persisting the resolved mode fails', async () => {
    mockConnect()
    mocks.getSshConnection.mockResolvedValue({ ...base, mode: 'foo' as never })
    mocks.upsertSshConnection.mockRejectedValue(new Error('disk full'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(ensureSshWorkspaceConnected(project)).resolves.toBeUndefined()

    expect(mocks.safeInvoke).toHaveBeenCalledWith(
      '连接 SSH 项目',
      'ssh_connect',
      expect.objectContaining({ config: expect.objectContaining({ mode: 'server' }) })
    )
    warn.mockRestore()
  })
})

describe('switchSshConnectionMode', () => {
  const project: Project = {
    id: 'p1',
    name: 'app',
    path: 'ssh://c1/home/app',
    kind: 'ssh',
    connection_id: 'c1',
    root_path: '/home/app',
    created_at: 1,
    last_opened_at: 1,
  }

  function connection(mode: SshConnection['mode']): SshConnection {
    return {
      id: 'c1',
      name: 'WSL',
      host: 'localhost',
      port: 22,
      username: 'root',
      auth_kind: 'privateKey',
      host_key_fingerprint: 'SHA256:test',
      created_at: 1,
      updated_at: 1,
      mode,
    }
  }

  function storedConnection(initial: SshConnection['mode']) {
    let stored = connection(initial)
    mocks.getSshConnection.mockImplementation(async () => stored)
    mocks.upsertSshConnection.mockImplementation(async (next: SshConnection) => {
      stored = next
    })
    return () => stored
  }

  it('returns early when the mode is unchanged', async () => {
    storedConnection('server')

    await switchSshConnectionMode('c1', 'server')

    expect(mocks.upsertSshConnection).not.toHaveBeenCalled()
    expect(mocks.safeInvoke).not.toHaveBeenCalled()
  })

  it('only writes the row when the connection is offline', async () => {
    const read = storedConnection('server')
    mocks.safeInvoke.mockResolvedValue(false)

    await switchSshConnectionMode('c1', 'ssh')

    expect(read().mode).toBe('ssh')
    expect(mocks.safeInvoke).toHaveBeenCalledTimes(1)
    expect(mocks.safeInvoke).toHaveBeenCalledWith('检查 SSH 连接', 'ssh_connection_status', {
      connectionId: 'c1',
    })
  })

  it('stops every root, keeps going when one stop fails, then disconnects and reconnects the current project', async () => {
    storedConnection('server')
    mocks.currentProject = project
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.safeInvoke.mockImplementation(
      async (_label: string, command: string, args: Record<string, unknown>) => {
        if (command === 'ssh_connection_status') return true
        if (command === 'ssh_workspace_roots') {
          return [
            { rootUri: 'ssh://c1/home/a', trusted: true },
            { rootUri: 'ssh://c1/home/b', trusted: true },
          ]
        }
        if (command === 'ssh_server_stop') {
          if (args.rootUri === 'ssh://c1/home/a') throw new Error('daemon offline')
          return undefined
        }
        if (command === 'ssh_disconnect') return undefined
        if (command === 'ssh_workspace_status') return false
        if (command === 'ssh_connect') return { fingerprint: 'SHA256:test' }
        throw new Error(`Unexpected command: ${command}`)
      }
    )

    await switchSshConnectionMode('c1', 'ssh')

    const stops = mocks.safeInvoke.mock.calls.filter(call => call[1] === 'ssh_server_stop')
    expect(stops.map(call => (call[2] as { rootUri: string }).rootUri)).toEqual([
      'ssh://c1/home/a',
      'ssh://c1/home/b',
    ])
    expect(mocks.safeInvoke).toHaveBeenCalledWith('断开 SSH 连接', 'ssh_disconnect', {
      connectionId: 'c1',
    })
    expect(mocks.safeInvoke).toHaveBeenCalledWith(
      '连接 SSH 项目',
      'ssh_connect',
      expect.objectContaining({ config: expect.objectContaining({ mode: 'ssh' }) })
    )
    expect(mocks.refreshProjectTree).toHaveBeenCalledWith(project)
    warn.mockRestore()
  })

  it('keeps the new mode in the database when reconnecting fails', async () => {
    const read = storedConnection('server')
    mocks.currentProject = project
    mocks.safeInvoke.mockImplementation(
      async (_label: string, command: string) => {
        if (command === 'ssh_connection_status') return true
        if (command === 'ssh_workspace_roots') return []
        if (command === 'ssh_disconnect') return undefined
        if (command === 'ssh_workspace_status') return false
        if (command === 'ssh_connect') throw new Error('auth failed')
        throw new Error(`Unexpected command: ${command}`)
      }
    )

    await expect(switchSshConnectionMode('c1', 'ssh')).rejects.toThrow('auth failed')
    expect(read().mode).toBe('ssh')
    expect(mocks.refreshProjectTree).not.toHaveBeenCalled()
  })

  it('does not reconnect when the current project belongs to another connection', async () => {
    storedConnection('server')
    mocks.currentProject = { ...project, path: 'ssh://c2/home/app', connection_id: 'c2' }
    mocks.safeInvoke.mockImplementation(async (_label: string, command: string) => {
      if (command === 'ssh_connection_status') return true
      if (command === 'ssh_workspace_roots') return []
      if (command === 'ssh_disconnect') return undefined
      throw new Error(`Unexpected command: ${command}`)
    })

    await switchSshConnectionMode('c1', 'ssh')

    expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
      '连接 SSH 项目',
      'ssh_connect',
      expect.anything()
    )
    expect(mocks.refreshProjectTree).not.toHaveBeenCalled()
  })

  it('serializes concurrent switches and disconnects only once', async () => {
    storedConnection('server')
    mocks.safeInvoke.mockImplementation(async (_label: string, command: string) => {
      if (command === 'ssh_connection_status') return true
      if (command === 'ssh_workspace_roots') return []
      if (command === 'ssh_disconnect') return undefined
      throw new Error(`Unexpected command: ${command}`)
    })

    await Promise.all([
      switchSshConnectionMode('c1', 'ssh'),
      switchSshConnectionMode('c1', 'ssh'),
    ])

    expect(mocks.upsertSshConnection).toHaveBeenCalledTimes(1)
    expect(
      mocks.safeInvoke.mock.calls.filter(call => call[1] === 'ssh_disconnect')
    ).toHaveLength(1)
  })
})
