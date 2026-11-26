import { describe, expect, it } from 'vitest'
import { asSession, sessionScope, sessionsOf } from './codexSessions'

function fakeRpc() {
  return {
    request: async () => ({}),
    onNotification: () => () => undefined,
  }
}

describe('codex 会话形状适配', () => {
  it('读取已打开的会话', () => {
    const rpc = fakeRpc()
    const session = asSession({ rpc, opened: true, state: {} })
    expect(session?.opened).toBe(true)
    expect(session?.rpc).toBe(rpc)
  })

  it('忽略缺少 rpc 或非法形状的对象', () => {
    expect(asSession(null)).toBeNull()
    expect(asSession({ opened: true })).toBeNull()
    expect(asSession({ rpc: { request: () => undefined }, opened: true })).toBeNull()
    expect(asSession([{ rpc: fakeRpc(), opened: true }])).toBeNull()
  })

  it('从 store 状态筛出可用会话', () => {
    const rpc = fakeRpc()
    expect(
      Object.keys(
        sessionsOf({
          sessions: {
            local: { rpc, opened: true },
            ssh: { rpc: fakeRpc(), opened: false },
            broken: { opened: true },
            nullish: null,
          },
        }),
      ),
    ).toEqual(['local', 'ssh'])
    expect(sessionsOf({})).toEqual({})
    expect(sessionsOf(null)).toEqual({})
    expect(sessionsOf({ sessions: [] })).toEqual({})
  })

  it('从复合会话键还原目标与 agent', () => {
    expect(sessionScope('claude:ssh:22')).toEqual({ agent: 'claude', targetId: 'ssh:22' })
    expect(sessionScope('codex:local')).toEqual({ agent: 'codex', targetId: 'local' })
    expect(sessionScope('local')).toEqual({ agent: 'codex', targetId: 'local' })
  })
})
