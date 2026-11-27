import { describe, expect, it } from 'vitest'
import { emptyAccessMemory, getAccessMode, rememberAccessMode, resetDraftAccess, turnAccessOverride } from './accessModel'

describe('会话访问模式', () => {
  const session = { targetId: 'remote', agent: 'codex', threadId: 'first' } as const
  const draft = { ...session, threadId: null }

  it('会话默认继承总控，显式选择可覆盖并恢复继承', () => {
    expect(getAccessMode(emptyAccessMemory, draft, 'auto')).toBe('auto')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'claude' }, 'auto')).toBe('auto')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'pi' }, 'auto')).toBe('default')
    const override = rememberAccessMode(emptyAccessMemory, session, 'default')
    expect(getAccessMode(override, session, 'auto')).toBe('default')
    expect(getAccessMode(rememberAccessMode(override, session, 'inherit'), session, 'auto')).toBe('auto')
  })

  it('总控为完全访问时各 Agent 统一为完全访问，显式选择仍优先', () => {
    expect(getAccessMode(emptyAccessMemory, draft, 'fullAccess')).toBe('fullAccess')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'claude' }, 'fullAccess')).toBe('fullAccess')
    expect(getAccessMode(emptyAccessMemory, { ...session, agent: 'pi' }, 'fullAccess')).toBe('default')
    expect(getAccessMode(rememberAccessMode(emptyAccessMemory, session, 'auto'), session, 'fullAccess')).toBe('auto')
  })

  it('拒绝已移除的旧档位', () => {
    const legacy = rememberAccessMode(emptyAccessMemory, session, 'readOnly' as never)
    expect(legacy).toBe(emptyAccessMemory)
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
    expect(turnAccessOverride('codex', 'auto')).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      qingcodeAccessOverride: true,
    })
    expect(turnAccessOverride('codex', 'fullAccess')).toEqual({
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, qingcodeAccessOverride: true,
    })
    expect(turnAccessOverride('claude', 'auto')).toEqual({ claudePermissionMode: 'auto' })
    expect(turnAccessOverride('claude', 'fullAccess')).toEqual({ claudePermissionMode: 'bypassPermissions' })
    expect(turnAccessOverride('claude', 'default')).toBeNull()
    expect(turnAccessOverride('claude', 'plan')).toBeNull()
    expect(turnAccessOverride('pi', 'fullAccess')).toBeNull()
  })
})
