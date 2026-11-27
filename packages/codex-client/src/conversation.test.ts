import { describe, expect, it, vi } from 'vitest'
import type { RequestId, ServerNotification, ServerRequest, Thread, Turn, UserInput } from './codex-types'
import {
  DRAFT_THREAD_ID,
  addOptimisticUser,
  applyNotification,
  applyServerRequest,
  approvalResponse,
  clearDraftThread,
  dropOptimisticUsers,
  emptyState,
  failActiveThreads,
  loadRecentThreadHistory,
  loadThread,
  moveOptimisticUsers,
  prependThreadHistory,
  resolveServerRequest,
  userItemFromInput,
} from './conversation'
import type { ConversationState, ItemView, LoadableThread } from './conversation'
import { sessionStatus } from './threadStatus'
import { groupTurns, streamingReplyId } from './turnGroups'

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

describe('按需读取会话历史', () => {
  it('最近页保留实时条目和审批，前插早期页时去重且保持当前轮次', () => {
    const active = { id: 'active', status: 'inProgress', items: [] } as unknown as Turn
    let state = reduce(emptyState(), [
      note('turn/started', { threadId: 't1', turn: active }),
      note('item/started', { threadId: 't1', turnId: 'active', item: item('agentMessage', 'live', { text: '实时回复' }) }),
    ])
    state = applyServerRequest(state, request('item/commandExecution/requestApproval', 'approval', { threadId: 't1', itemId: 'command' }))
    const before = state.threads.t1
    const thread = { id: 't1', status: { type: 'active' }, turns: [active] } as unknown as Thread
    state = loadRecentThreadHistory(state, thread, { turns: 'previous' }, before)
    const older = { id: 'old', status: 'completed', items: [item('agentMessage', 'old-reply', { text: '早期回复' })] } as unknown as Turn
    state = prependThreadHistory(state, 't1', { turns: [older, { ...active, items: [item('agentMessage', 'live', { text: '旧快照' })] as unknown as Turn['items'] }], earlier: null })
    expect(state.threads.t1).toMatchObject({
      activeTurnId: 'active', status: 'running', pendingApprovals: [{ requestId: 'approval' }], historyCursor: null,
      items: [{ id: 'old-reply', text: '早期回复' }, { id: 'live', text: '实时回复' }],
      turns: [{ id: 'old' }, { id: 'active', itemIds: ['live'] }],
    })
  })
})

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

it('后台任务通知保留流式回复和用户占位，状态与结果在主时间线中可见', () => {
  const pending = addOptimisticUser(emptyState(), 't1', { kind: 'user', id: 'pending', text: '继续检查', pending: true })
  const task = item('backgroundTaskNotification', 'task', { status: 'stopped', summary: '检查', result: '**已停止**' })
  const state = reduce(pending, [
    note('item/agentMessage/delta', { threadId: 't1', turnId: 'active', itemId: 'reply', delta: '正在回复' }),
    note('item/completed', { threadId: 't1', turnId: '', item: task }),
  ])
  expect(itemOf(state, 'pending')).toMatchObject({ kind: 'user', pending: true })
  expect(itemOf(state, 'reply')).toMatchObject({ streaming: true })
  expect(threadOf(state)).toMatchObject({ status: 'running', activeTurnId: 'active', turns: [{ itemIds: ['reply'] }] })
  const thread = threadOf(state)
  expect(streamingReplyId(thread)).toBe('reply')
  const inTurn = applyNotification(state, note('item/completed', { threadId: 't1', turnId: 'active', item: task }))
  expect(streamingReplyId(threadOf(inTurn))).toBe('reply')
  expect(groupTurns(thread.items, thread.turns, true)).toContainEqual({
    kind: 'item', key: 'task', item: { kind: 'backgroundTask', id: 'task', status: 'stopped', summary: '检查', result: '**已停止**' },
  })
})

it('记录实际回复完成时间，重读历史时保留同条回复已收到的时间', () => {
  const raw = item('agentMessage', 'reply', { text: '已完成' })
  const startedAtMs = 1_796_000_000_000
  const completedAtMs = startedAtMs + 60_000
  const started = applyNotification(emptyState(), note('item/started', { threadId: 't1', item: raw, startedAtMs }))
  expect(itemOf(started, 'reply')).not.toHaveProperty('completedAtMs')
  const done = applyNotification(started, note('item/completed', { threadId: 't1', item: raw, completedAtMs }))
  expect(itemOf(done, 'reply')).toMatchObject({ completedAtMs, streaming: false })

  const turn = { id: 't', status: 'completed', completedAt: completedAtMs / 1000, items: [raw, { ...raw, id: 'unknown' }] }
  const reread = loadThread(done, { id: 't1', turns: [turn] } as unknown as LoadableThread)
  expect(itemOf(reread, 'reply')).toMatchObject({ completedAtMs })
  expect(itemOf(reread, 'unknown')).not.toHaveProperty('completedAtMs')
  const recorded = loadThread(emptyState(), { id: 't1', turns: [{ ...turn, items: [{ ...raw, completedAtMs }] }] } as unknown as LoadableThread)
  expect(itemOf(recorded, 'reply')).toMatchObject({ completedAtMs })
})

const userItem = item('userMessage', 'i-user', {
  clientId: null,
  content: [{ type: 'text', text: '请执行命令', text_elements: [] }],
})

it('加载会话时记下 Thread 上的模型与推理强度，后续不带配置的快照保留原值', () => {
  const loaded = loadThread(emptyState(), { id: 't1', model: 'gpt-5.5', reasoningEffort: 'high', turns: [] } as unknown as LoadableThread)
  expect(threadOf(loaded).savedConfig).toEqual({ model: 'gpt-5.5', effort: 'high' })
  const again = loadThread(loaded, { id: 't1', turns: [] } as unknown as LoadableThread)
  expect(threadOf(again).savedConfig).toEqual({ model: 'gpt-5.5', effort: 'high' })
  expect(threadOf(loadThread(emptyState(), { id: 't1', model: null, turns: [] } as unknown as LoadableThread)).savedConfig).toBeUndefined()
})

describe('跨端会话状态', () => {
  it('从状态事件区分待审批、待输入和运行中', () => {
    const change = (activeFlags: string[]) => note('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags } })
    const pending = applyNotification(emptyState(), change(['waitingOnApproval']))
    expect(sessionStatus(threadOf(pending))).toBe('pending')
    const waiting = applyNotification(pending, change(['waitingOnUserInput']))
    expect(sessionStatus(threadOf(waiting))).toBe('input')
    expect(sessionStatus(threadOf(applyNotification(waiting, change([]))))).toBe('running')
  })

  it('进程退出时结束正在运行的会话并清除旧审批', () => {
    const state = applyServerRequest(emptyState(), request('item/commandExecution/requestApproval', 'r', { threadId: 't1', turnId: 'a', command: 'echo test' }))
    const exited = threadOf(failActiveThreads(state, 'Agent 进程已退出'))
    expect(exited).toMatchObject({ activity: 'failed', activeTurnId: null, pendingApprovals: [], error: 'Agent 进程已退出' })
    expect(sessionStatus(exited)).toBe('failed')
  })

  it.each(['completed', 'failed', 'interrupted'] as const)('idle 通知保留 %s，下一轮开始时恢复运行中', (status) => {
    const turn = { id: 'a', status, items: [], error: status === 'failed' ? { message: '发送失败' } : null }
    const finished = reduce(emptyState(), [
      note('turn/started', { threadId: 't1', turn: { ...turn, status: 'inProgress' } }),
      note('turn/completed', { threadId: 't1', turn }),
      note('thread/status/changed', { threadId: 't1', status: { type: 'idle' } }),
    ])
    expect(sessionStatus(threadOf(finished), 'running')).toBe(status)
    if (status === 'failed') expect(threadOf(finished).error).toBe('发送失败')
    const reloaded = loadThread(emptyState(), { id: 't1', status: { type: 'idle' }, turns: [turn] } as unknown as LoadableThread)
    expect(sessionStatus(threadOf(reloaded))).toBe(status)
    const next = applyNotification(finished, note('turn/started', { threadId: 't1', turn: { ...turn, id: 'b', status: 'inProgress' } }))
    expect(sessionStatus(threadOf(next), undefined, true)).toBe('running')
    expect(threadOf(next).error).toBeUndefined()
  })

  it('旧轮次迟到的条目和中断结果保留当前轮的运行状态', () => {
    const started = reduce(emptyState(), [
      note('turn/started', { threadId: 't1', turn: { id: 'old', status: 'inProgress', items: [] } }),
      note('turn/started', { threadId: 't1', turn: { id: 'current', status: 'inProgress', items: [] } }),
      note('item/agentMessage/delta', { threadId: 't1', turnId: 'current', itemId: 'reply', delta: '还在运行' }),
    ])
    const running = applyServerRequest(started, request('item/commandExecution/requestApproval', 'approval', {
      threadId: 't1', turnId: 'current', command: 'echo test',
    }))
    const updated = reduce(running, [
      note('item/completed', { threadId: 't1', turnId: 'old', item: userItem }),
      note('error', { threadId: 't1', turnId: 'old', willRetry: false, error: { message: '上一轮出错' } }),
      note('turn/completed', { threadId: 't1', turn: { id: 'old', status: 'interrupted', items: [] } }),
    ])
    const view = threadOf(updated)
    expect(view).toMatchObject({ status: 'running', activeTurnId: 'current' })
    expect(view.error).toBeUndefined()
    expect(view.pendingApprovals).toHaveLength(1)
    expect(view.turns?.[0]).toMatchObject({ id: 'old', outcome: 'interrupted', itemIds: ['i-user'] })
    expect(itemOf(updated, 'reply')).toMatchObject({ streaming: true })
    expect(itemOf(updated, 'i-user')).toMatchObject({ kind: 'user' })

    const finished = applyNotification(updated, note('turn/completed', {
      threadId: 't1', turn: { id: 'current', status: 'interrupted', items: [] },
    }))
    expect(threadOf(finished)).toMatchObject({ activity: 'interrupted', activeTurnId: null, pendingApprovals: [] })
    expect(itemOf(finished, 'reply')).toMatchObject({ streaming: false })
  })

  it('保留停止轮次的零毫秒用时和历史记录', () => {
    const stopped = { id: 'stopped', status: 'interrupted', items: [userItem], durationMs: 0 }
    const state = reduce(emptyState(), [
      note('turn/started', { threadId: 't1', turn: { ...stopped, status: 'inProgress', durationMs: null } }),
      note('turn/completed', { threadId: 't1', turn: stopped }),
      note('turn/started', { threadId: 't1', turn: { id: 'next', status: 'inProgress', items: [] } }),
    ])
    const expected = { id: 'stopped', outcome: 'interrupted', durationMs: 0, itemIds: ['i-user'] }
    expect(threadOf(state).turns?.[0]).toMatchObject(expected)
    const snapshot = { id: 't1', turns: [stopped, { id: 'next', status: 'completed', items: [] }] } as unknown as LoadableThread
    expect(threadOf(loadThread(emptyState(), snapshot)).turns?.[0]).toMatchObject(expected)
    const older = { ...stopped, id: 'older', durationMs: null, startedAt: 100, completedAt: 100 } as unknown as Turn
    const paged = prependThreadHistory(state, 't1', { turns: [older], earlier: null })
    expect(threadOf(paged).turns?.[0]).toMatchObject({ ...expected, id: 'older' })
  })

  it('实时、回放和历史读取使用服务端用时，缺少计时不按客户端时钟估算', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_796_000_000_050)
      const started = applyNotification(emptyState(), note('turn/started', { threadId: 't1', turn: { id: 't', status: 'inProgress', items: [] } }))
      const turn = { id: 't', status: 'interrupted', items: [], durationMs: 544_000 }
      const stopped = note('turn/completed', { threadId: 't1', turn })
      vi.setSystemTime(1_796_000_000_450)
      const done = applyNotification(started, stopped)
      vi.setSystemTime(1_796_000_010_000)
      const expected = { outcome: 'interrupted', durationMs: 544_000 }
      expect(threadOf(done).turns?.[0]).toMatchObject(expected)
      expect(threadOf(applyNotification(emptyState(), stopped)).turns?.[0]).toMatchObject(expected)
      const read = (durationMs: number | null) => loadThread(emptyState(), { id: 't1', turns: [{ ...turn, durationMs }] } as unknown as LoadableThread)
      expect(threadOf(read(544_000)).turns?.[0]).toMatchObject(expected)
      expect(threadOf(read(null)).turns?.[0]?.durationMs).toBeNull()
      const missing = note('turn/completed', { threadId: 't1', turn: { ...turn, durationMs: null } })
      expect(threadOf(applyNotification(started, missing)).turns?.[0]?.durationMs).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('子代理条目', () => {
  it('区分调用已返回和子代理自己的状态', () => {
    const spawn = item('collabAgentToolCall', 'spawn', { tool: 'spawnAgent', status: 'inProgress' })
    const atStart = applyNotification(emptyState(), note('item/started', { threadId: 't1', item: spawn }))
    expect(itemOf(atStart, 'spawn')).toMatchObject({ kind: 'subagent', title: '启动子代理', status: '调用中' })
    const completed = {
      ...spawn, status: 'completed', agentsStates: { child: { status: 'running', message: null } },
    }
    const atReturn = applyNotification(atStart, note('item/completed', { threadId: 't1', item: completed }))
    expect(itemOf(atReturn, 'spawn')).toMatchObject({
      status: '调用已返回',
      agents: [{ threadId: 'child', status: '运行中' }],
    })
  })

  it('从历史还原 Codex 子代理活动和 Claude 委派', () => {
    const items = [
      item('subAgentActivity', 'activity', { kind: 'completed', agentPath: '/root/review' }),
      item('dynamicToolCall', 'delegate', {
        tool: 'Agent', namespace: 'claude', status: 'failed', arguments: { description: '核对文档' },
      }),
    ]
    const thread = { id: 't1', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items }] }
    const state = loadThread(emptyState(), thread as unknown as LoadableThread)
    expect(threadOf(state).items).toEqual([
      { kind: 'subagent', id: 'activity', title: '子代理', status: '已完成', detail: '/root/review' },
      { kind: 'subagent', id: 'delegate', title: '委派给子代理', status: '调用失败', detail: '核对文档', name: '核对文档' },
    ])
  })

  it('历史最后一轮失败时显示失败原因，之前失败而后成功则不显示', () => {
    const failed = { id: 'a', status: 'failed', error: { message: '429: usage limit' }, items: [] }
    const ok = { id: 'b', status: 'completed', error: null, items: [] }
    const load = (turns: unknown[]) =>
      threadOf(loadThread(emptyState(), { id: 't1', status: { type: 'idle' }, turns } as unknown as LoadableThread))
    expect(load([ok, failed])).toMatchObject({ status: 'error', error: '429: usage limit' })
    const recovered = load([failed, ok])
    expect(recovered.status).toBe('idle')
    expect(recovered.error).toBeUndefined()
  })
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

  it('用户消息解析图片、附件文件与技能', () => {
    const thread = {
      id: 't1',
      status: { type: 'idle' },
      turns: [
        {
          id: 'turn0',
          status: 'completed',
          startedAt: 1760000000,
          error: null,
          items: [
            item('userMessage', 'u1', {
              content: [
                { type: 'skill', name: 'commit-push', path: '/s/SKILL.md' },
                { type: 'text', text: '看图' },
                { type: 'image', url: 'data:image/png;base64,AAAA' },
                { type: 'localImage', path: '/tmp/a.png' },
                { type: 'mention', name: 'a.log', path: '/tmp/a.log' },
              ],
            }),
          ],
        },
      ],
    } as unknown as LoadableThread
    const state = loadThread(emptyState(), thread)
    expect(itemOf(state, 'u1')).toEqual({
      kind: 'user',
      id: 'u1',
      text: '看图',
      images: ['data:image/png;base64,AAAA', '/tmp/a.png'],
      files: ['/tmp/a.log'],
      skills: ['commit-push'],
      inputExtras: [
        { type: 'skill', name: 'commit-push', path: '/s/SKILL.md' },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
        { type: 'localImage', path: '/tmp/a.png' },
        { type: 'mention', name: 'a.log', path: '/tmp/a.log' },
      ],
      sentAt: 1760000000000,
    })
  })
})

const textInput = (text: string): UserInput[] => [{ type: 'text', text, text_elements: [] }]

describe('乐观用户消息', () => {
  it('发送内容先转成占位气泡（含技能、图片、附件）', () => {
    const input: UserInput[] = [
      { type: 'skill', name: 'review', path: '/s/review' },
      { type: 'text', text: '看图', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
      { type: 'mention', name: 'a.log', path: '/tmp/a.log' },
    ]
    expect(userItemFromInput('local-1', input)).toEqual({
      kind: 'user',
      id: 'local-1',
      text: '看图',
      images: ['data:image/png;base64,AAAA'],
      files: ['/tmp/a.log'],
      skills: ['review'],
      pending: true,
    })
  })

  it('草稿态占位搬到真实会话后，被服务端回显替换且不重复', () => {
    let state = addOptimisticUser(emptyState(), DRAFT_THREAD_ID, userItemFromInput('local-1', textInput('你好')))
    expect(threadOf(state, DRAFT_THREAD_ID).items[0]).toMatchObject({ id: 'local-1', pending: true })
    state = moveOptimisticUsers(state, DRAFT_THREAD_ID, 't1')
    expect(state.threads[DRAFT_THREAD_ID]).toBeUndefined()
    expect(threadOf(state).items.map((item) => item.id)).toEqual(['local-1'])
    state = applyNotification(state, note('item/completed', { threadId: 't1', turnId: 'turn1', item: userItem }))
    expect(threadOf(state).items).toHaveLength(1)
    expect(threadOf(state).items[0]).toMatchObject({ id: 'i-user', kind: 'user', text: '请执行命令' })
    expect(threadOf(state).items[0]).not.toHaveProperty('pending', true)
  })

  it('turn/started 里带回显时同样替换占位', () => {
    let state = addOptimisticUser(emptyState(), 't1', userItemFromInput('local-1', textInput('你好')))
    state = applyNotification(state, note('turn/started', {
      threadId: 't1',
      turnId: 'turn1',
      turn: { id: 'turn1', status: 'inProgress', items: [userItem] },
    }))
    expect(threadOf(state).items.map((item) => item.id)).toEqual(['i-user'])
  })

  it('历史快照和实时回显用同一个客户端消息 ID 合并带图消息', () => {
    const input: UserInput[] = [...textInput('看图'), { type: 'image', url: 'data:image/png;base64,AAAA' }]
    let state = addOptimisticUser(emptyState(), 't1', userItemFromInput('local-1', input))
    const before = threadOf(state)
    const turn = { id: 'turn1', status: 'inProgress', items: [] }
    state = reduce(state, [
      note('turn/started', { threadId: 't1', turn }),
      note('item/started', { threadId: 't1', turnId: turn.id, item: item('userMessage', 'live-user', {
        clientId: 'local-1', content: input,
      }), startedAtMs: 1760000000000 }),
      note('item/agentMessage/delta', { threadId: 't1', turnId: turn.id, itemId: 'reply', delta: '正在看图' }),
    ])
    const history = { ...turn, items: [item('userMessage', 'history-user', { clientId: 'local-1', content: input })] }
    const thread = { id: 't1', status: { type: 'active' }, turns: [history] } as unknown as Thread
    state = loadRecentThreadHistory(state, thread, null, before)
    expect(threadOf(state).items).toMatchObject([
      { id: 'local-1', kind: 'user', text: '看图', images: ['data:image/png;base64,AAAA'], sentAt: 1760000000000 },
      { id: 'reply', kind: 'agent', text: '正在看图' },
    ])
    expect(threadOf(state).turns?.[0]?.itemIds).toEqual(['local-1', 'reply'])
  })

  it('历史先收到回显时，合并与恢复发送都不会重新加回占位', () => {
    const input = textInput('问题')
    const pending = userItemFromInput('local-1', input)
    let state = addOptimisticUser(emptyState(), 't1', pending)
    const echo = item('userMessage', 'server-id', { clientId: 'local-1', content: input })
    const turn = { id: 'turn1', status: 'inProgress', items: [echo] }
    const thread = { id: 't1', turns: [turn] } as unknown as Thread
    state = loadRecentThreadHistory(state, thread, null, undefined)
    state = addOptimisticUser(state, 't1', pending)
    expect(threadOf(state).items).toMatchObject([{ id: 'local-1', text: '问题' }])
    expect(threadOf(state).items[0]).not.toHaveProperty('pending', true)
  })

  it('历史加载保留尚未回显的占位，确认后同内容的两次发送各显示一条', () => {
    const input: UserInput[] = [{ type: 'image', url: 'data:image/png;base64,AAAA' }]
    const older = item('userMessage', 'first-send', { content: input })
    const history = { id: 't1', turns: [{ id: 'older', items: [older] }] } as unknown as Thread
    let state = loadThread(emptyState(), history)
    state = addOptimisticUser(state, 't1', userItemFromInput('second-send', input))
    state = loadRecentThreadHistory(state, history, null, threadOf(state))
    expect(threadOf(state).items.map((entry) => entry.id)).toEqual(['first-send', 'second-send'])
    state = applyNotification(state, note('turn/started', {
      threadId: 't1',
      turn: { id: 'next', status: 'inProgress', items: [
        item('userMessage', 'second-item', { clientId: 'second-send', content: input }),
      ] },
    }))
    expect(threadOf(state).items.map((entry) => entry.id)).toEqual(['first-send', 'second-send'])
    expect(threadOf(state).items.every((entry) => entry.kind === 'user' && !entry.pending)).toBe(true)
  })

  it('搬运草稿占位时保留真实会话先到的回显', () => {
    const input = textInput('同一条消息')
    let state = addOptimisticUser(emptyState(), DRAFT_THREAD_ID, userItemFromInput('local-1', input))
    state = applyNotification(state, note('item/completed', {
      threadId: 't1', item: item('userMessage', 'echo', { clientId: 'local-1', content: input }),
    }))
    state = moveOptimisticUsers(state, DRAFT_THREAD_ID, 't1')
    expect(state.threads[DRAFT_THREAD_ID]).toBeUndefined()
    expect(threadOf(state).items).toMatchObject([{ id: 'local-1', text: '同一条消息' }])
    expect(threadOf(state).items[0]).not.toHaveProperty('pending', true)
  })

  it('旧消息的重复通知和其他客户端的相同正文都保留本地占位', () => {
    const input = textInput('相同正文')
    const first = item('userMessage', 'old', { content: input })
    const receive = (state: ConversationState, raw: Params) => applyNotification(state, note('item/completed', {
      threadId: 't1', turnId: 'turn1', item: raw,
    }))
    let state = receive(emptyState(), first)
    state = addOptimisticUser(state, 't1', userItemFromInput('local-1', input))
    state = receive(state, first)
    state = receive(state, item('userMessage', 'external', { clientId: 'external-1', content: input }))
    expect(threadOf(state).items.map((entry) => entry.id)).toEqual(['old', 'local-1', 'external-1'])
    expect(threadOf(state).items[1]).toMatchObject({ pending: true })
    state = receive(state, item('userMessage', 'local-echo', { clientId: 'local-1', content: input }))
    expect(threadOf(state).items.map((entry) => entry.id)).toEqual(['old', 'local-1', 'external-1'])
    expect(threadOf(state).items[1]).not.toHaveProperty('pending', true)
  })

  it('连续两条占位按到达顺序分别被回显替换', () => {
    let state = addOptimisticUser(emptyState(), 't1', userItemFromInput('l1', textInput('一')))
    state = addOptimisticUser(state, 't1', userItemFromInput('l2', textInput('二')))
    state = applyNotification(state, note('item/completed', {
      threadId: 't1',
      item: item('userMessage', 'u1', { content: [{ type: 'text', text: '一' }] }),
    }))
    expect(threadOf(state).items.map((item) => item.id)).toEqual(['u1', 'l2'])
    state = applyNotification(state, note('item/completed', {
      threadId: 't1',
      item: item('userMessage', 'u2', { content: [{ type: 'text', text: '二' }] }),
    }))
    expect(threadOf(state).items.map((item) => item.id)).toEqual(['u1', 'u2'])
  })

  it('回显带技能前缀与附件说明时按原文找对应占位', () => {
    let state = addOptimisticUser(emptyState(), 't1', userItemFromInput('l1', textInput('一')))
    state = addOptimisticUser(state, 't1', userItemFromInput('l2', textInput('二')))
    state = applyNotification(state, note('item/completed', {
      threadId: 't1',
      item: item('userMessage', 'u2', {
        content: [{ type: 'text', text: '/review 二\n\n附件文件（请按需读取）：\n- a.log: /tmp/a.log' }],
      }),
    }))
    expect(threadOf(state).items.map((entry) => entry.id)).toEqual(['l1', 'u2'])
  })

  it('发送失败时撤掉占位并清掉空草稿线程', () => {
    let state = addOptimisticUser(emptyState(), DRAFT_THREAD_ID, userItemFromInput('local-1', textInput('你好')))
    state = applyNotification(state, note('item/started', {
      threadId: 't1',
      item: item('agentMessage', 'a1', { text: '', status: 'inProgress' }),
    }))
    state = dropOptimisticUsers(state, [DRAFT_THREAD_ID, 't1'])
    expect(state.threads[DRAFT_THREAD_ID]).toBeUndefined()
    expect(threadOf(state).items.map((item) => item.id)).toEqual(['a1'])
    expect(clearDraftThread(addOptimisticUser(emptyState(), DRAFT_THREAD_ID, userItemFromInput('l2', textInput('重试'))))).toEqual(emptyState())
  })
})


describe('流式光标收尾', () => {
  it('新条目出现时，上一条未收到 item/completed 的消息结束流式', () => {
    let state = applyNotification(emptyState(), note('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'a1',
      delta: '先说明一下',
    }))
    expect(itemOf(state, 'a1')).toMatchObject({ streaming: true })
    state = applyNotification(state, note('item/commandExecution/outputDelta', {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'c1',
      delta: 'ok',
    }))
    expect(itemOf(state, 'a1')).toMatchObject({ streaming: false })
  })
})

describe('进行中轮次的历史加载', () => {
  it('只有最后一条回复保留流式光标', () => {
    const turn = {
      id: 'turn1',
      status: 'inProgress',
      items: [
        { type: 'agentMessage', id: 'a1', text: '先看看路线图' },
        { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', aggregatedOutput: '', exitCode: 0 },
        { type: 'agentMessage', id: 'a2', text: '我会更新进度表' },
        { type: 'commandExecution', id: 'c2', command: 'cat', status: 'inProgress', aggregatedOutput: '' },
      ],
    }
    const state = loadThread(emptyState(), { id: 't1', status: { type: 'active' }, turns: [turn] } as unknown as LoadableThread)
    const agents = state.threads.t1!.items.filter((item) => item.kind === 'agent')
    expect(agents.map((item) => item.kind === 'agent' && item.streaming)).toEqual([false, false])
    expect(state.threads.t1!.status).toBe('running')
  })
})
