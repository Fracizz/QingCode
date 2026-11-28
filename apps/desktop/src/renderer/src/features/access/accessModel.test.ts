import { describe, expect, it } from 'vitest'
import {
  branchAccessSelection, emptyAccessMemory, getAccessMode, getAccessSelection, leavePlanMode, planReturnSelection,
  rememberAccessMode, resetDraftAccess, resetTargetAccess, turnAccessOverride,
} from './accessModel'

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
    expect(turnAccessOverride('claude', 'plan')).toEqual({ claudePermissionMode: 'plan' })
    expect(turnAccessOverride('codex', 'plan')).toBeNull()
    expect(turnAccessOverride('pi', 'fullAccess')).toBeNull()
  })

  it('计划模式只给支持的 Agent，批准后切回选它之前的档位', () => {
    const claude = { ...session, agent: 'claude' } as const
    expect(rememberAccessMode(emptyAccessMemory, session, 'plan')).toBe(emptyAccessMemory)
    const auto = rememberAccessMode(emptyAccessMemory, claude, 'auto')
    const plan = rememberAccessMode(auto, claude, 'plan')
    expect(getAccessMode(plan, claude, 'fullAccess')).toBe('plan')
    expect(planReturnSelection(plan, claude)).toBe('auto')
    // 重复选计划模式不能把返回档位覆盖成计划模式本身。
    expect(planReturnSelection(rememberAccessMode(plan, claude, 'plan'), claude)).toBe('auto')
    const left = leavePlanMode(plan, claude)
    expect(getAccessSelection(left, claude)).toBe('auto')
    expect(leavePlanMode(left, claude)).toBe(left)
    expect(getAccessSelection(leavePlanMode(rememberAccessMode(emptyAccessMemory, claude, 'plan'), claude), claude)).toBe('inherit')
  })

  it('草稿带着返回档位转成会话', () => {
    const claudeDraft = { ...draft, agent: 'claude' } as const
    const claude = { ...session, agent: 'claude' } as const
    const drafted = rememberAccessMode(rememberAccessMode(emptyAccessMemory, claudeDraft, 'fullAccess'), claudeDraft, 'plan')
    expect(planReturnSelection(drafted, claudeDraft)).toBe('fullAccess')
    const moved = rememberAccessMode(drafted, claude, getAccessSelection(drafted, claudeDraft),
      planReturnSelection(drafted, claudeDraft))
    expect(getAccessSelection(leavePlanMode(moved, claude), claude)).toBe('fullAccess')
    expect(planReturnSelection(resetTargetAccess(moved, 'remote', 'claude'), claude)).toBe('inherit')
  })

  it('分支会话不带走提升的权限，但保留比总控更严格的选择', () => {
    const claude = { ...session, agent: 'claude' } as const
    const choose = (mode: 'plan' | 'default' | 'auto' | 'fullAccess') => rememberAccessMode(emptyAccessMemory, claude, mode)
    expect(branchAccessSelection(choose('fullAccess'), claude, 'default')).toBe('inherit')
    expect(branchAccessSelection(choose('auto'), claude, 'default')).toBe('inherit')
    expect(branchAccessSelection(choose('plan'), claude, 'fullAccess')).toBe('plan')
    expect(branchAccessSelection(choose('default'), claude, 'fullAccess')).toBe('default')
    expect(branchAccessSelection(choose('auto'), claude, 'fullAccess')).toBe('auto')
    expect(branchAccessSelection(emptyAccessMemory, claude, 'fullAccess')).toBe('inherit')
  })
})
