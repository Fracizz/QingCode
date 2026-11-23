import { describe, expect, it } from 'vitest'
import type { SshConnection } from '../types'
import { buildProjectSourceOptions, type ProjectFilterData } from './projectManagerFilters'

const connection = (id: string, name: string, host: string): SshConnection => ({
  id,
  name,
  host,
  port: 22,
  username: 'root',
  auth_kind: 'password',
  host_key_fingerprint: '',
  created_at: 0,
  updated_at: 0,
})

const data = (kind: ProjectFilterData['kind'], source: string, sourceLabel: string): ProjectFilterData => ({
  kind,
  source,
  sourceLabel,
  searchText: '',
})

describe('buildProjectSourceOptions', () => {
  it('SSH 分组只列本机已配置的连接，不为未知连接生成「SSH」条目', () => {
    const filterData = new Map([
      ['p1', data('ssh', 'ssh:gone', 'SSH')],
      ['p2', data('ssh', 'ssh:', 'SSH')],
      ['p3', data('wsl', 'wsl:Ubuntu', 'WSL · Ubuntu')],
      ['p4', data('wsl', 'wsl', 'WSL')],
      ['p5', data('local', 'local', '本机')],
    ])
    const options = buildProjectSourceOptions(
      filterData,
      [connection('b', 'ycy', '10.0.0.2'), connection('a', 'dev', '10.0.0.1')],
      'zh-CN'
    )
    expect(options).toEqual([
      { kind: 'wsl', source: 'wsl:Ubuntu', sourceLabel: 'WSL · Ubuntu' },
      { kind: 'ssh', source: 'ssh:a', sourceLabel: 'dev（root@10.0.0.1）' },
      { kind: 'ssh', source: 'ssh:b', sourceLabel: 'ycy（root@10.0.0.2）' },
    ])
  })
})
