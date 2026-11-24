import { describe, expect, it } from 'vitest'
import type { SshConnection } from '../types'
import { buildProjectSourceOptions } from './projectManagerFilters'

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

describe('buildProjectSourceOptions', () => {
  it('只列本机已配置的远程连接并按名称排序', () => {
    const options = buildProjectSourceOptions(
      [connection('b', 'ycy', '10.0.0.2'), connection('a', 'dev', '10.0.0.1')],
      'zh-CN'
    )
    expect(options).toEqual([
      { source: 'ssh:a', sourceLabel: 'dev（root@10.0.0.1）' },
      { source: 'ssh:b', sourceLabel: 'ycy（root@10.0.0.2）' },
    ])
  })
})
