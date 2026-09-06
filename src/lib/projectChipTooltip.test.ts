import { describe, expect, it } from 'vitest'
import type { Project, SshConnection } from '../types'
import { projectChipTooltipLabel } from './projectChipTooltip'

const sshProject: Project = {
  id: 'ssh-project',
  name: 'qingcode',
  path: 'ssh://wsl-connection/home/dev/qingcode',
  kind: 'ssh',
  connection_id: 'wsl-connection',
  root_path: '/home/dev/qingcode',
  created_at: 1,
  last_opened_at: 1,
}

const sshConnection: SshConnection = {
  id: 'wsl-connection',
  name: 'WSL 开发机',
  host: '127.0.0.1',
  port: 2222,
  username: 'dev',
  auth_kind: 'privateKey',
  host_key_fingerprint: 'fingerprint',
  created_at: 1,
  updated_at: 1,
}

const t = (source: string, values?: Record<string, string | number>) =>
  source.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`))

describe('projectChipTooltipLabel', () => {
  it('shows the SSH connection identity and remote path', () => {
    expect(projectChipTooltipLabel(sshProject, [sshConnection], t)).toBe(
      'qingcode · SSH 远程项目\n' +
        'SSH 连接：WSL 开发机（dev@127.0.0.1:2222）\n' +
        '远程路径：/home/dev/qingcode'
    )
  })

  it('keeps the saved connection id visible when its connection row is unavailable', () => {
    expect(projectChipTooltipLabel(sshProject, [], t)).toContain('SSH 连接：wsl-connection')
  })

  it('keeps local project tooltips concise', () => {
    expect(
      projectChipTooltipLabel(
        { ...sshProject, name: '本地项目', path: 'D:/code/local', kind: 'local' },
        [sshConnection],
        t
      )
    ).toBe('本地项目')
  })
})
