import { describe, expect, it } from 'vitest'
import type { RequestId, ServerNotification, ServerRequest } from './codex-types'
import {
  applyNotification,
  applyServerRequest,
  approvalResponse,
  emptyState,
  loadThread,
  resolveServerRequest,
} from './conversation'
import type { ConversationState, ItemView, LoadableThread } from './conversation'

type Params = Record<string, unknown>

function note(method: string, params: Params): ServerNotification {
  return { method, params } as unknown as ServerNotification
}

function request(method: string, id: RequestId, params: Params): ServerRequest {
  return { method, id, params } as unknown as ServerRequest
}

function item(type: string, id: string, fields: Params = {}): Params {
  return { type, id, ...fields }
}

function reduce(s: ConversationState, notifications: ServerNotification[]): ConversationState {
  for (const n of notifications) s = applyNotification(s, n)
  return s
}

function threadOf(s: ConversationState, id = 't1') {
  const thread = s.threads[id]
  if (!thread) throw new Error(`missing thread ${id}`)
  return thread
}

function itemOf(s: ConversationState, id: string): ItemView {
  const found = threadOf(s).items.find((entry) => entry.id === id)
  if (!found) throw new Error(`missing item ${id}`)
  return found
}

const userItem = item('userMessage', 'i-user', {
  clientId: null,
  content: [{ type: 'text', text: '请执行命令', text_elements: [] }],
})

const reasoningStart = item('reasoning', 'i-reason', { summary: [], content: [] })
const reasoningDone = item('reasoning', 'i-reason', { summary: ['分析', '确认'], content: [] })

const commandStart = item('commandExecution', 'i-command', {
  command: 'echo hi',
  cwd: '/tmp',
  status: 'inProgress',
  commandActions: [],
  aggregatedOutput: '',
  exitCode: null,
  processId: null,
  source: 'userShell',
  pluginId: null,
  scriptPath: null,
  durationMs: null,
})
const commandDone = item('commandExecution', 'i-command', {
  ...commandStart,
  status: 'completed',
  aggregatedOutput: 'hi\n',
  exitCode: 0,
  durationMs: 12,
})

const patchChange = {
  path: 'a.txt',
  kind: { type: 'update', move_path: null },
  diff: '--- a/a.txt\n+++ b/a.txt\n+hello\n',
}
const patchChange2 = {
  path: 'b.txt',
  kind: { type: 'add' },
  diff: '--- /dev/null\n+++ b/b.txt\n+world\n',
}
const fileChangeStart = item('fileChange', 'i-file', {
  changes: [patchChange],
  status: 'inProgress',
})
const fileChangeDone = item('fileChange', 'i-file', {
  changes: [patchChange, patchChange2],
  status: 'completed',
})

const agentStart = item('agentMessage', 'i-agent', {
  text: '',
  phase: null,
  moderation: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
})
const agentDone = item('agentMessage', 'i-agent', {
  ...agentStart,
  text: '完成了',
})

function fullTurnNotifications(): ServerNotification[] {
  return [
    note('thread/started', { thread: { id: 't1', status: { type: 'idle' }, turns: [] } }),
    note('turn/started', {
      threadId: 't1',
      turnId: 'turn1',
      turn: { id: 'turn1', status: 'inProgress', items: [], error: null },
    }),
    note('item/started', { threadId: 't1', turnId: 'turn1', item: userItem }),
    note('item/completed', { threadId: 't1', turnId: 'turn1', item: userItem }),
    note('item/started', { threadId: 't1', turnId: 'turn1', item: reasoningStart }),
    note('item/reasoning/summaryPartAdded', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-reason',
      summaryIndex: 0,
    }),
    note('item/reasoning/summaryTextDelta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-reason',
      summaryIndex: 0,
      delta: '分析',
    }),
    note('item/reasoning/summaryPartAdded', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-reason',
      summaryIndex: 1,
    }),
    note('item/reasoning/summaryTextDelta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-reason',
      summaryIndex: 1,
      delta: '确认',
    }),
    note('item/completed', { threadId: 't1', turnId: 'turn1', item: reasoningDone }),
    note('item/started', { threadId: 't1', turnId: 'turn1', item: commandStart }),
    note('item/commandExecution/outputDelta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-command',
      delta: 'hi\n',
    }),
    note('item/completed', { threadId: 't1', turnId: 'turn1', item: commandDone }),
    note('item/started', { threadId: 't1', turnId: 'turn1', item: fileChangeStart }),
    note('item/fileChange/outputDelta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-file',
      delta: 'patch output\n',
    }),
    note('item/fileChange/patchUpdated', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-file',
      changes: [patchChange, patchChange2],
    }),
    note('item/completed', { threadId: 't1', turnId: 'turn1', item: fileChangeDone }),
    note('item/started', { threadId: 't1', turnId: 'turn1', item: agentStart }),
    note('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-agent',
      delta: '完成',
    }),
    note('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-agent',
      delta: '了',
    }),
    note('item/completed', { threadId: 't1', turnId: 'turn1', item: agentDone }),
    note('thread/tokenUsage/updated', {
      threadId: 't1',
      turnId: 'turn1',
      tokenUsage: { total: { inputTokens: 10 }, last: { inputTokens: 2 }, modelContextWindow: null },
    }),
    note('turn/completed', {
      threadId: 't1',
      turn: { id: 'turn1', status: 'completed', items: [], error: null },
    }),
  ]
}

describe('conversation reducer', () => {
  it('还原一次完整 turn 的流式增量', () => {
    const initial = emptyState()
    const state = reduce(initial, fullTurnNotifications())
    const thread = threadOf(state)

    expect(initial.threads).toEqual({})
    expect(state).not.toBe(initial)
    expect(thread.items.map((entry) => entry.kind)).toEqual([
      'user',
      'reasoning',
      'command',
      'fileChange',
      'agent',
    ])
    expect(itemOf(state, 'i-user')).toMatchObject({ kind: 'user', text: '请执行命令' })
    expect(itemOf(state, 'i-reason')).toMatchObject({
      kind: 'reasoning',
      summary: '分析\n\n确认',
      streaming: false,
    })
    expect(itemOf(state, 'i-command')).toMatchObject({
      kind: 'command',
      command: 'echo hi',
      cwd: '/tmp',
      output: 'hi\n',
      exitCode: 0,
      status: 'completed',
    })
    expect(itemOf(state, 'i-file')).toMatchObject({
      kind: 'fileChange',
      status: 'completed',
      changes: [
        { path: 'a.txt', kind: 'update', diff: expect.stringContaining('patch output\n') },
        { path: 'b.txt', kind: 'add' },
        { path: '(patch output)', kind: 'output', diff: 'patch output\n' },
      ],
    })
    expect(itemOf(state, 'i-agent')).toMatchObject({
      kind: 'agent',
      text: '完成了',
      streaming: false,
    })
    expect(thread.status).toBe('idle')
    expect(thread.activeTurnId).toBeNull()
    expect(thread.tokenUsage).toEqual({
      total: { inputTokens: 10 },
      last: { inputTokens: 2 },
      modelContextWindow: null,
    })
  })

  it('审批出现、去重、本地解决与 server 通知解决', () => {
    const commandApproval = request('item/commandExecution/requestApproval', 5, {
      kind: 'command',
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-command',
      startedAtMs: 1,
      command: 'echo hi',
      cwd: '/tmp',
      reason: '需要执行 shell',
      commandActions: [],
      environmentId: null,
    })
    let state = applyServerRequest(emptyState(), commandApproval)
    expect(threadOf(state).pendingApprovals).toHaveLength(1)
    const approval = threadOf(state).pendingApprovals[0]!
    expect(approval).toMatchObject({
      requestId: 5,
      threadId: 't1',
      itemId: 'i-command',
      kind: 'command',
      method: 'item/commandExecution/requestApproval',
    })
    expect(approval.detail).toContain('echo hi')
    expect(threadOf(state).status).toBe('running')

    expect(approvalResponse(approval, 'accept')).toEqual({ decision: 'accept' })
    expect(approvalResponse(approval, 'acceptForSession')).toEqual({ decision: 'acceptForSession' })
    expect(approvalResponse(approval, 'decline')).toEqual({ decision: 'decline' })

    state = applyServerRequest(state, commandApproval)
    expect(threadOf(state).pendingApprovals).toHaveLength(1)
    state = resolveServerRequest(state, 5)
    expect(threadOf(state).pendingApprovals).toEqual([])

    state = applyServerRequest(state, request('item/fileChange/requestApproval', 6, {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-file',
      startedAtMs: 2,
      reason: '写入文件',
      grantRoot: null,
    }))
    expect(approvalResponse(threadOf(state).pendingApprovals[0]!, 'acceptForSession')).toEqual({
      decision: 'acceptForSession',
    })
    state = applyNotification(state, note('serverRequest/resolved', { threadId: 't1', requestId: 6 }))
    expect(threadOf(state).pendingApprovals).toEqual([])
  })

  it('权限与旧版审批生成 vendor 响应体', () => {
    const permissions = request('item/permissions/requestApproval', 7, {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-perm',
      environmentId: null,
      startedAtMs: 3,
      cwd: '/repo',
      reason: '需要网络',
      permissions: { network: { enabled: true }, fileSystem: null },
    })
    const state = applyServerRequest(emptyState(), permissions)
    const approval = threadOf(state).pendingApprovals[0]!
    expect(approval.kind).toBe('permissions')
    expect(approvalResponse(approval, 'accept')).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    })
    expect(approvalResponse(approval, 'acceptForSession')).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    })
    expect(approvalResponse(approval, 'decline')).toEqual({ permissions: {}, scope: 'turn' })

    const legacyCommand = request('execCommandApproval', 8, {
      conversationId: 't2',
      callId: 'call-1',
      approvalId: null,
      command: ['git', 'status'],
      cwd: '/repo',
      reason: null,
      parsedCmd: [],
    })
    const legacyState = applyServerRequest(emptyState(), legacyCommand)
    const legacyApproval = threadOf(legacyState, 't2').pendingApprovals[0]!
    expect(legacyApproval.kind).toBe('command')
    expect(approvalResponse(legacyApproval, 'accept')).toEqual({ decision: 'approved' })
    expect(approvalResponse(legacyApproval, 'acceptForSession')).toEqual({
      decision: 'approved_for_session',
    })
    expect(approvalResponse(legacyApproval, 'decline')).toEqual({
      decision: { denied: { rejection: '用户拒绝该操作' } },
    })

    const legacyPatch = request('applyPatchApproval', 9, {
      conversationId: 't2',
      callId: 'call-2',
      fileChanges: { 'a.txt': { kind: 'update' } },
      reason: null,
      grantRoot: null,
    })
    const patchState = applyServerRequest(emptyState(), legacyPatch)
    const patchApproval = threadOf(patchState, 't2').pendingApprovals[0]!
    expect(patchApproval.detail).toContain('a.txt')
    expect(approvalResponse(patchApproval, 'accept')).toEqual({ decision: 'approved' })
  })

  it('中断、错误通知与未知通知', () => {
    let state = reduce(emptyState(), [
      note('turn/started', {
        threadId: 't1',
        turnId: 'turn1',
        turn: { id: 'turn1', status: 'inProgress', items: [], error: null },
      }),
      note('item/started', { threadId: 't1', turnId: 'turn1', item: agentStart }),
      note('turn/completed', {
        threadId: 't1',
        turn: { id: 'turn1', status: 'interrupted', items: [], error: null },
      }),
    ])
    expect(threadOf(state).status).toBe('error')
    expect(threadOf(state).activeTurnId).toBeNull()
    expect(threadOf(state).error).toBe('Turn interrupted')
    expect(itemOf(state, 'i-agent')).toMatchObject({ streaming: false })

    state = applyNotification(state, note('error', {
      threadId: 't1',
      turnId: 'turn2',
      willRetry: false,
      error: { message: '连接失败' },
    }))
    expect(threadOf(state).error).toBe('连接失败')

    const otherState = applyServerRequest(emptyState(), request('item/tool/requestUserInput', 12, {
      threadId: 't3',
      turnId: 'turn3',
      itemId: 'i-question',
      questions: [],
      isBlocking: true,
    }))
    expect(threadOf(otherState, 't3').pendingApprovals[0]).toMatchObject({
      kind: 'other',
      method: 'item/tool/requestUserInput',
    })

    const before = state
    const after = applyNotification(before, note('some/unknown', { threadId: 't1' }))
    expect(after).toBe(before)
    expect(() => applyNotification(before, { method: 'turn/started' } as unknown as ServerNotification)).not.toThrow()
  })

  it('loadThread 后可继续接收增量并保留未决审批', () => {
    const thread = {
      id: 't1',
      status: { type: 'idle' },
      turns: [
        {
          id: 'turn0',
          status: 'completed',
          error: null,
          items: [userItem, item('agentMessage', 'i-agent', { ...agentStart, text: '已有' })],
        },
      ],
    } as unknown as LoadableThread

    let state = applyServerRequest(emptyState(), request('item/commandExecution/requestApproval', 11, {
      threadId: 't1',
      turnId: 'turn0',
      itemId: 'i-command',
      command: 'echo hi',
    }))
    state = loadThread(state, thread)
    expect(threadOf(state).items).toHaveLength(2)
    expect(itemOf(state, 'i-agent')).toMatchObject({ text: '已有', streaming: false })
    expect(threadOf(state).pendingApprovals).toHaveLength(1)

    const before = state
    state = applyNotification(state, note('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'i-agent',
      delta: '，新增',
    }))
    expect(before).not.toBe(state)
    expect(itemOf(before, 'i-agent')).toMatchObject({ text: '已有' })
    expect(itemOf(state, 'i-agent')).toMatchObject({ text: '已有，新增', streaming: true })

    state = applyNotification(state, note('item/completed', {
      threadId: 't1',
      turnId: 'turn1',
      item: item('agentMessage', 'i-agent', { ...agentStart, text: '已有，新增' }),
    }))
    expect(itemOf(state, 'i-agent')).toMatchObject({ text: '已有，新增', streaming: false })
  })
})
