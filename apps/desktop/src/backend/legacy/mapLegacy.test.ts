import { describe, expect, it } from 'vitest'
import { projectKey } from '../projectStore'
import {
  countLegacy,
  isDirectConnection,
  legacyTargetId,
  mapLegacyAuth,
  mapLegacyConnection,
  mapLegacyProject,
  normalizeLegacyTimestamp,
  planLegacyImport,
  type ExistingLegacyState,
  type LegacyRow,
  type LegacySnapshot,
} from './mapLegacy'

const hex64 = 'a'.repeat(64)
const conn = (row: LegacyRow): LegacyRow => ({
  id: 'c1',
  name: 'Host 93',
  host: '192.168.10.93',
  port: 22,
  username: 'root',
  auth_kind: 'password',
  host_key_fingerprint: 'SHA256:abc',
  ...row,
})

const emptyState = (): ExistingLegacyState => ({
  targetIds: new Set(),
  projectKeys: new Set(),
  hostKeys: new Set(),
  secretTargetIds: new Set(),
})

const snapshot: LegacySnapshot = {
  connections: [
    conn({ id: 'c1', port: 2222 }),
    conn({
      id: 'c2', name: 'Key host', host: '10.0.0.2', port: '22', username: 'admin',
      auth_kind: 'privateKey', private_key_path: 'C:\\keys\\id', host_key_fingerprint: 'SHA256:def',
    }),
    conn({ id: 'd1', name: 'Direct', host: '10.0.0.3', username: 'Agent', host_key_fingerprint: hex64 }),
    conn({ id: 'bad', name: 'Broken', host: '', host_key_fingerprint: '' }),
  ],
  projects: [
    { name: 'Local A', path: 'C:\\work\\a', last_opened_at: 1_700_000_000, hidden: 1 },
    { kind: 'local', name: 'Local B', path: '/home/u/b', last_opened_at: 1_700_000_000_000 },
    { kind: 'ssh', name: 'Remote', connection_id: 'c1', root_path: '/srv/app', path: 'C:\\placeholder', last_opened_at: 1_700_000_000 },
    { kind: 'ssh', name: 'Orphan', connection_id: 'missing', root_path: '/srv/x', last_opened_at: 1 },
  ],
  secrets: { c1: 'Yw==', d1: 'ZA==' },
}

describe('isDirectConnection', () => {
  it('Agent + 64 位十六进制指纹或 direct/agent mode 跳过，server mode（SSH+server）不跳过', () => {
    expect(isDirectConnection(conn({ username: 'Agent', host_key_fingerprint: hex64 }))).toBe(true)
    expect(isDirectConnection(conn({ mode: 'server' }))).toBe(false)
    expect(isDirectConnection(conn({ mode: 'Server' }))).toBe(false)
    expect(isDirectConnection(conn({ mode: 'direct' }))).toBe(true)
    expect(isDirectConnection(conn({ mode: 'agent' }))).toBe(true)
  })

  it('普通 SSH 条目（含 ssh mode、SHA256 指纹）不跳过', () => {
    expect(isDirectConnection(conn({ mode: 'ssh' }))).toBe(false)
    expect(isDirectConnection(conn({ username: 'Agent', host_key_fingerprint: 'SHA256:tls' }))).toBe(false)
    expect(isDirectConnection(conn({}))).toBe(false)
  })
})

describe('mapLegacyAuth', () => {
  it('privateKey 需要 keyPath，其他/未知降级为 agent', () => {
    expect(mapLegacyAuth(conn({}))).toEqual({ kind: 'password' })
    expect(mapLegacyAuth(conn({ auth_kind: 'privateKey', private_key_path: 'C:\\k\\id' }))).toEqual({ kind: 'key', keyPath: 'C:\\k\\id' })
    expect(mapLegacyAuth(conn({ auth_kind: 'private_key', private_key_path: '/home/u/.ssh/id' }))).toEqual({ kind: 'key', keyPath: '/home/u/.ssh/id' })
    expect(mapLegacyAuth(conn({ auth_kind: 'privateKey', private_key_path: null }))).toEqual({ kind: 'agent' })
    expect(mapLegacyAuth(conn({ auth_kind: 'something' }))).toEqual({ kind: 'agent' })
    expect(mapLegacyAuth({})).toEqual({ kind: 'agent' })
  })
})

describe('normalizeLegacyTimestamp', () => {
  it('秒转毫秒、毫秒保持、异常归零', () => {
    expect(normalizeLegacyTimestamp(1_700_000_000)).toBe(1_700_000_000_000)
    expect(normalizeLegacyTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(normalizeLegacyTimestamp('1700000000')).toBe(1_700_000_000_000)
    expect(normalizeLegacyTimestamp(1700000000000n)).toBe(1_700_000_000_000)
    expect(normalizeLegacyTimestamp(0)).toBe(0)
    expect(normalizeLegacyTimestamp(-1)).toBe(0)
    expect(normalizeLegacyTimestamp('bad')).toBe(0)
    expect(normalizeLegacyTimestamp(null)).toBe(0)
  })
})

describe('mapLegacyConnection', () => {
  it('生成 legacy-<旧 id> 目标与 host:port 指纹', () => {
    const mapped = mapLegacyConnection(conn({ id: 'c1', port: 2222 }))
    expect(mapped.targetId).toBe('legacy-c1')
    expect(mapped.target).toEqual({
      id: 'legacy-c1', name: 'Host 93', host: '192.168.10.93', port: 2222,
      username: 'root', auth: { kind: 'password' },
    })
    expect(mapped.hostKey).toEqual({ key: '192.168.10.93:2222', fingerprint: 'SHA256:abc' })
    expect(mapped.skipped).toEqual([])
    expect(legacyTargetId('c1')).toBe('legacy-c1')
  })

  it('缺列容错：port 缺省 22、name 回落 host、非 SHA256 指纹跳过', () => {
    const mapped = mapLegacyConnection({
      id: 'c9', host: 'h.test', username: 'u', auth_kind: 'password',
      host_key_fingerprint: 'plain-text-fp',
    })
    expect(mapped.target?.port).toBe(22)
    expect(mapped.target?.name).toBe('h.test')
    expect(mapped.hostKey).toBeNull()
    expect(mapped.skipped).toEqual([
      { kind: 'hostKey', name: 'h.test:22', reason: '指纹格式不支持' },
    ])
  })

  it('直连条目、缺 id/host/username 都记入 skipped', () => {
    expect(mapLegacyConnection(conn({ username: 'Agent', host_key_fingerprint: hex64 })).skipped[0]).toMatchObject({ reason: 'Server 直连条目' })
    expect(mapLegacyConnection({ name: 'x' }).skipped[0]?.reason).toBe('缺少连接 id')
    expect(mapLegacyConnection(conn({ host: '' })).skipped[0]?.reason).toBe('缺少主机地址')
    expect(mapLegacyConnection(conn({ username: '' })).skipped[0]?.reason).toBe('缺少用户名')
  })
})

describe('mapLegacyProject', () => {
  const known = new Set(['legacy-c1'])

  it('kind 缺失按本机导入，hidden=1 也导入，时间戳归一', () => {
    const mapped = mapLegacyProject(snapshot.projects[0]!, known)
    expect(mapped.project).toEqual({
      targetId: 'local', name: 'Local A', path: 'C:\\work\\a', lastOpenedAt: 1_700_000_000_000,
    })
  })

  it('远端项目用 root_path 与 legacy-<connection_id> 目标', () => {
    const mapped = mapLegacyProject(snapshot.projects[2]!, known)
    expect(mapped.project).toEqual({
      targetId: 'legacy-c1', name: 'Remote', path: '/srv/app', lastOpenedAt: 1_700_000_000_000,
    })
  })

  it('缺列与孤儿连接给出跳过原因', () => {
    expect(mapLegacyProject({ kind: 'ssh', root_path: '/x' }, known).skipped[0]?.reason).toBe('缺少关联连接 id')
    expect(mapLegacyProject(snapshot.projects[3]!, known).skipped[0]?.reason).toBe('关联连接不存在或未导入')
    expect(mapLegacyProject({ kind: 'ssh', connection_id: 'c1', root_path: '' }, known).skipped[0]?.reason).toBe('缺少远端项目路径')
    expect(mapLegacyProject({ kind: 'local', path: '' }, known).skipped[0]?.reason).toBe('缺少项目路径')
  })

  it('root_path 缺失时回落到 path，name 缺省取目录名', () => {
    const mapped = mapLegacyProject({ kind: 'ssh', connection_id: 'c1', path: '/srv/fallback' }, known)
    expect(mapped.project?.path).toBe('/srv/fallback')
    expect(mapped.project?.name).toBe('fallback')
    expect(mapped.project?.lastOpenedAt).toBe(0)
  })
})

describe('countLegacy / planLegacyImport', () => {
  it('detect 计数按原始行数', () => {
    expect(countLegacy(snapshot)).toEqual({
      connections: 4, localProjects: 2, sshProjects: 2, secrets: 2,
    })
  })

  it('首次导入只写有效项，直连/孤儿/无效指纹进 skipped', () => {
    const plan = planLegacyImport(snapshot, emptyState(), true)
    expect(plan.targets.map((t) => t.id)).toEqual(['legacy-c1', 'legacy-c2'])
    expect(plan.hostKeys.map((h) => h.key)).toEqual(['192.168.10.93:2222', '10.0.0.2:22'])
    expect(plan.projects.map((p) => p.targetId)).toEqual(['local', 'local', 'legacy-c1'])
    expect(plan.secretIds).toEqual([{ legacyId: 'c1', targetId: 'legacy-c1' }])
    expect(plan.skipped).toEqual(expect.arrayContaining([
      { kind: 'connection', name: 'Direct', reason: 'Server 直连条目' },
      { kind: 'connection', name: 'Broken', reason: '缺少主机地址' },
      { kind: 'project', name: 'Orphan', reason: '关联连接不存在或未导入' },
      { kind: 'secret', name: 'd1', reason: '关联连接不存在或未导入' },
    ]))
  })

  it('重复导入幂等：全部进 skipped，不再写任何数据', () => {
    const current: ExistingLegacyState = {
      targetIds: new Set(['legacy-c1', 'legacy-c2']),
      projectKeys: new Set([
        projectKey('local', 'C:\\work\\a'),
        projectKey('local', '/home/u/b'),
        projectKey('legacy-c1', '/srv/app'),
      ]),
      hostKeys: new Set(['192.168.10.93:2222', '10.0.0.2:22']),
      secretTargetIds: new Set(['legacy-c1']),
    }
    const plan = planLegacyImport(snapshot, current, true)
    expect(plan.targets).toEqual([])
    expect(plan.projects).toEqual([])
    expect(plan.hostKeys).toEqual([])
    expect(plan.secretIds).toEqual([])
    expect(plan.skipped.some((s) => s.reason === '已导入')).toBe(true)
    expect(plan.skipped.some((s) => s.reason === '已存在')).toBe(true)
    expect(plan.skipped.filter((s) => s.kind === 'project' && s.reason === '已存在')).toHaveLength(3)
  })

  it('includeSecrets=false 时完全不碰凭据', () => {
    const plan = planLegacyImport(snapshot, emptyState(), false)
    expect(plan.secretIds).toEqual([])
    expect(plan.skipped.some((s) => s.kind === 'secret')).toBe(false)
    expect(plan.targets).toHaveLength(2)
  })

  it('同一次导入内重复条目只写一次', () => {
    const duplicated: LegacySnapshot = {
      connections: [conn({ id: 'c1' }), conn({ id: 'c1' })],
      projects: [
        { kind: 'local', name: 'A', path: '/p' },
        { kind: 'local', name: 'A2', path: '/p' },
      ],
      secrets: {},
    }
    const plan = planLegacyImport(duplicated, emptyState(), true)
    expect(plan.targets).toHaveLength(1)
    expect(plan.hostKeys).toHaveLength(1)
    expect(plan.projects).toHaveLength(1)
  })
})
