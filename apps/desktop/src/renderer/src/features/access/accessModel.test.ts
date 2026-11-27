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

  it('总控为完全访问时，Codex 关闭沙箱、Claude 跳过审批，显式选择仍优先', () => {
    expect(getAccessMode(emptyAccessMemory, draft, 'fullAccess')).toBe('fullAccess')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'claude' }, 'fullAccess')).toBe('bypassPermissions')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'pi' }, 'fullAccess')).toBe('default')
    expect(getAccessMode(rememberAccessMode(emptyAccessMemory, session, 'readOnly'), session, 'fullAccess')).toBe('readOnly')
  })

  it('总控为自动时，Claude 使用自动模式，Codex 与 pi 沿用 Agent 默认', () => {
    const claude = { ...session, agent: 'claude' } as const
    expect(getAccessMode(emptyAccessMemory, claude, 'auto')).toBe('auto')
    expect(turnAccessOverride('claude', 'auto')).toEqual({ claudePermissionMode: 'auto' })
    expect(getAccessMode(emptyAccessMemory, draft, 'auto')).toBe('default')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'pi' }, 'auto')).toBe('default')
    expect(getAccessMode(rememberAccessMode(emptyAccessMemory, claude, 'auto'), claude)).toBe('auto')
    // Codex 没有该档位，会话级选择被忽略。
    expect(getAccessMode(rememberAccessMode(emptyAccessMemory, session, 'auto'), session)).toBe('default')
    expect(turnAccessOverride('codex', 'auto')).toBeNull()
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
