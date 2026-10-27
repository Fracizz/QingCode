import type { Project, SshConnection } from '../types'

/** Fixed synthetic records: addresses, roots, and ids never come from the user's DB. */
export function projectManagerFixtures() {
  const now = Date.now()
  const sshConnections: SshConnection[] = [
    {
      id: 'fixture-wsl',
      name: 'WSL',
      host: 'localhost',
      port: 22,
      username: 'root',
      auth_kind: 'privateKey',
      host_key_fingerprint: 'fixture-only',
      created_at: 1,
      updated_at: 1,
    },
    {
      id: 'fixture-windev',
      name: 'WinDev',
      host: '192.0.2.107',
      port: 28822,
      username: 'administrator',
      auth_kind: 'privateKey',
      host_key_fingerprint: 'fixture-only',
      created_at: 1,
      updated_at: 1,
    },
  ]
  const base = (id: string, name: string, path: string, hidden = 0): Project => ({
    id,
    name,
    path,
    hidden,
    created_at: now - 86400000,
    last_opened_at: now - 60000,
  })
  const remote = (
    id: string,
    name: string,
    connectionId: string,
    root: string,
    hidden = 0
  ): Project => ({
    ...base(id, name, `ssh://${connectionId}${root}`, hidden),
    kind: 'ssh',
    connection_id: connectionId,
    root_path: root,
  })
  const projects: Project[] = [
    {
      ...base('ubuntu-django', 'django', String.raw`\\wsl$\Ubuntu\home\code\django`),
      kind: 'wsl' as const,
    },
    remote('win-nem', 'nem-panel', 'fixture-windev', '/D:/code/nem-panel'),
    remote('win-django', 'django', 'fixture-windev', '/D:/code/django'),
    remote('win-qingcode', 'qingcode', 'fixture-windev', '/D:/code/qingcode'),
    remote('wsl-nem', 'nem-panel', 'fixture-wsl', '/home/code/nem-panel'),
    base('local-qingcode', 'QingCode', 'D:/fixtures/QingCode', 1),
    remote('wsl-django', 'django', 'fixture-wsl', '/home/code/django', 1),
    remote('wsl-eman', 'eman-next', 'fixture-wsl', '/home/code/eman-next', 1),
    base(
      'local-zhizao',
      'zhizao-yun-ruan-ying-jian-pei-zhi-fen-xi-xi-tong',
      'D:/fixtures/zhizao',
      1
    ),
    base('local-tests', 'ai-auto-test-dev', 'D:/fixtures/ai-auto-test-dev', 1),
    // Legacy UNC rows and URI paths both identify native WSL without connection-name heuristics.
    base('debian-app', 'debian-service', 'wsl://Debian/home/dev/debian-service', 1),
    base(
      'ubuntu-tools',
      'ubuntu-tools',
      String.raw`\\wsl.localhost\Ubuntu\home\dev\ubuntu-tools`,
      1
    ),
    base('local-alpha', 'Alpha', 'D:/fixtures/alpha', 1),
    base('local-beta', 'Beta', 'D:/fixtures/beta', 1),
    base('local-gamma', 'Gamma', 'D:/fixtures/gamma', 1),
    base('local-delta', 'Delta', 'D:/fixtures/delta', 1),
    { ...base('scratch', 'temporary-scratch', 'D:/fixtures/scratch'), ephemeral: true },
  ].map((project, index) => ({ ...project, last_opened_at: now - (index + 1) * 60000 }))
  return { projects, sshConnections }
}
