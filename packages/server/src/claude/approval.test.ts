import { describe, expect, it } from 'vitest'
import {
  approvalMethod,
  buildApprovalRequest,
  decisionFromResponse,
  permissionResult,
  sessionSuggestions,
} from './approval'
import type { Json } from './v2'

const base = {
  requestId: 'req-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  startedAtMs: 123,
}

describe('canUseTool → v2 审批请求', () => {
  it('Bash → commandExecution 审批，带命令与 cwd', () => {
    const request = buildApprovalRequest({
      ...base,
      toolName: 'Bash',
      input: { command: 'echo qn-ok', cwd: '/work' },
      reason: '需要执行',
    })
    expect(request.id).toBe('req-1')
    expect(request.method).toBe('item/commandExecution/requestApproval')
    expect(request.params).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      startedAtMs: 123,
      command: 'echo qn-ok',
      cwd: '/work',
      reason: '需要执行',
      kind: 'command',
    })
  })

  it('编辑类 → fileChange 审批，fileChanges 键为路径', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
      expect(approvalMethod(tool)).toBe('item/fileChange/requestApproval')
    }
    const request = buildApprovalRequest({
      ...base,
      toolName: 'Edit',
      input: { file_path: '/work/a.ts' },
    })
    expect(request.method).toBe('item/fileChange/requestApproval')
    expect(Object.keys(request.params.fileChanges as Json)).toEqual(['/work/a.ts'])
  })

  it('其他工具 → commandExecution 审批，command 写成「工具名 参数摘要」', () => {
    const request = buildApprovalRequest({
      ...base,
      toolName: 'Read',
      input: { file_path: '/work/a.ts' },
    })
    expect(request.method).toBe('item/commandExecution/requestApproval')
    expect(String(request.params.command)).toContain('Read')
    expect(String(request.params.command)).toContain('/work/a.ts')
  })

  it('参数摘要长度有上限，避免审批卡片被撑爆', () => {
    const request = buildApprovalRequest({
      ...base,
      toolName: 'Write',
      input: { file_path: 'a', content: 'x'.repeat(1000) },
    })
    expect(request.method).toBe('item/fileChange/requestApproval')
  })
})

describe('v2 审批响应 → SDK PermissionResult', () => {
  it('decisionFromResponse 支持四种决策与错误响应', () => {
    expect(decisionFromResponse({ id: 1, result: { decision: 'accept' } })).toBe('accept')
    expect(decisionFromResponse({ id: 1, result: { decision: 'acceptForSession' } })).toBe(
      'acceptForSession',
    )
    expect(decisionFromResponse({ id: 1, result: { decision: 'decline' } })).toBe('decline')
    expect(decisionFromResponse({ id: 1, result: { decision: 'cancel' } })).toBe('cancel')
    expect(decisionFromResponse({ id: 1, error: { code: -1, message: 'x' } })).toBe('decline')
    expect(decisionFromResponse(null)).toBe('decline')
  })

  it('accept → allow；acceptForSession → allow + session 级 suggestions', () => {
    expect(permissionResult({ result: { decision: 'accept' } })).toEqual({ behavior: 'allow' })
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo' }], behavior: 'allow', destination: 'userSettings' },
    ]
    const allowed = permissionResult(
      { result: { decision: 'acceptForSession' } },
      suggestions,
    )
    expect(allowed.behavior).toBe('allow')
    if (allowed.behavior !== 'allow') throw new Error('expected allow')
    expect(allowed.updatedPermissions).toEqual([
      { ...suggestions[0], destination: 'session' },
    ])
  })

  it('decline → deny「用户拒绝」；cancel → deny + interrupt', () => {
    expect(permissionResult({ result: { decision: 'decline' } })).toEqual({
      behavior: 'deny',
      message: '用户拒绝',
    })
    expect(permissionResult({ result: { decision: 'cancel' } })).toEqual({
      behavior: 'deny',
      message: '用户拒绝',
      interrupt: true,
    })
  })

  it('sessionSuggestions 只处理数组并统一改 destination', () => {
    expect(sessionSuggestions(undefined)).toEqual([])
    expect(sessionSuggestions('x')).toEqual([])
    expect(
      sessionSuggestions([{ type: 'addRules', destination: 'projectSettings' }, null]),
    ).toEqual([{ type: 'addRules', destination: 'session' }])
  })
})
