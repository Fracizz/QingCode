import { describe, expect, it } from 'vitest'
import { emptyAccessMemory, getAccessMode, rememberAccessMode, resetDraftAccess, turnAccessOverride } from './accessModel'

describe('会话访问模式', () => {
  const session = { targetId: 'remote', agent: 'codex', threadId: 'first' } as const
  const draft = { ...session, threadId: null }

  it('会话默认继承总控，显式选择可覆盖并恢复继承', () => {
    expect(getAccessMode(emptyAccessMemory, draft, 'restricted')).toBe('readOnly')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'claude' }, 'restricted')).toBe('plan')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'pi' }, 'restricted')).toBe('default')
    const override = rememberAccessMode(emptyAccessMemory, session, 'default')
    expect(getAccessMode(override, session, 'restricted')).toBe('default')
    expect(getAccessMode(rememberAccessMode(override, session, 'inherit'), session, 'restricted')).toBe('readOnly')
  })

  it('在草稿转会话后保留选择，新草稿、其他目标和其他会话使用默认权限', () => {
    const withDraft = rememberAccessMode(emptyAccessMemory, draft, 'fullAccess')
    const mode = getAccessMode(withDraft, draft)
    expect(mode).toBe('fullAccess')
    expect(getAccessMode(withDraft, { ...draft, targetId: 'local' })).toBe('default')
    expect(getAccessMode(withDraft, { ...draft, agent: 'claude' })).toBe('default')
    const memory = resetDraftAccess(rememberAccessMode(withDraft, session, mode))
    expect(getAccessMode(memory, draft)).toBe('default')
    expect(getAccessMode(memory, session)).toBe('fullAccess')
    expect(getAccessMode(memory, { ...session, threadId: 'second' })).toBe('default')
    expect(getAccessMode(memory, { ...session, targetId: 'local' })).toBe('default')
    expect(getAccessMode(rememberAccessMode(memory, session, 'default'), session)).toBe('default')
  })

  it('仅发送对应 Agent 原生支持的权限覆盖', () => {
    expect(turnAccessOverride('codex', 'default')).toBeNull()
    expect(turnAccessOverride('codex', 'readOnly')).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      qingcodeAccessOverride: true,
    })
    expect(turnAccessOverride('codex', 'fullAccess')).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(turnAccessOverride('claude', 'plan')).toEqual({ claudePermissionMode: 'plan' })
    expect(turnAccessOverride('claude', 'default')).toBeNull()
    expect(turnAccessOverride('claude', 'fullAccess')).toBeNull()
    expect(turnAccessOverride('pi', 'readOnly')).toBeNull()
  })
})
