import { describe, expect, it } from 'vitest'
import type { UserInput } from './codex-types'
import { applyNotification, emptyState, mergeSubagentHistory, type ItemView } from './conversation'
import { collectSubagents, describeSubagentItem, requestSubagents, subagentAvatar, SUBAGENT_AVATAR_VARIANTS, supportsSubagentRequests } from './subagents'

describe('随本条消息请求子代理', () => {
  it('只为 Codex 和 Claude 提供入口', () => {
    expect(supportsSubagentRequests('codex')).toBe(true)
    expect(supportsSubagentRequests('claude')).toBe(true)
    expect(supportsSubagentRequests('pi')).toBe(false)
  })

  it('追加请求时保留正文偏移、技能、图片与原始草稿', () => {
    const text: UserInput = { type: 'text', text: '@a', text_elements: [{ byteRange: { start: 0, end: 2 }, placeholder: '@a' }] }
    const skill: UserInput = { type: 'skill', name: 'demo', path: '/work/skills/demo' }
    const image: UserInput = { type: 'image', url: 'data:image/png;base64,AA==' }
    const input = [skill, text, image]
    const next = requestSubagents(input)
    expect(next).toEqual([skill, { ...text, text: expect.stringMatching(/^@a\n\n请.*子代理/) }, image])
    expect(input[1]).toEqual(text)
    expect(requestSubagents([image])).toEqual([image, {
      type: 'text', text: expect.stringContaining('子代理'), text_elements: [],
    }])
  })
})

describe('查看子代理详情', () => {
  it('保留尚无状态的接收方，并合并多个子代理的状态和结果', () => {
    const item = describeSubagentItem({
      type: 'collabAgentToolCall',
      tool: 'wait',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['first', 'second', 'first'],
      agentsStates: {
        parent: { status: 'running' },
        second: { status: 'completed', message: '检查通过' },
      },
      prompt: '检查变更',
    }, 'wait')
    expect(item?.detail).toBe('检查变更')
    expect(item?.agents).toEqual([
      { threadId: 'first', label: '', status: '', result: '' },
      { threadId: 'second', label: '', status: '已完成', result: '检查通过' },
    ])
    expect(describeSubagentItem({
      type: 'subAgentActivity', agentThreadId: 'first', agentPath: '/root/review', kind: 'started',
    }, 'activity')?.agents).toEqual([{ threadId: 'first', label: '/root/review', status: '已启动', result: '' }])
  })

  it('从 Claude 委派条目读取任务和工具返回文本', () => {
    const item = describeSubagentItem({
      type: 'dynamicToolCall',
      namespace: 'claude',
      tool: 'Task',
      arguments: { subagent_type: 'Explore', description: '检查变更', prompt: '核对测试覆盖' },
      contentItems: [{ type: 'text', text: '结果一' }, { type: 'inputImage', imageUrl: 'x' }, { type: 'inputText', text: '结果二' }],
      status: 'completed',
    }, 'task')
    expect(item).toMatchObject({ detail: 'Explore · 检查变更\n\n核对测试覆盖', result: '结果一\n\n结果二' })
    expect(item?.agents).toBeUndefined()
    expect(collectSubagents(item ? [item] : [])).toEqual([
      expect.objectContaining({ name: '检查变更', role: 'Explore', result: '结果一\n\n结果二' }),
    ])
  })

  it('将同一子会话的活动合并，实时状态只关联当前父会话', () => {
    const items = [
      describeSubagentItem({ type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', prompt: '检查变更',
        receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }, 'spawn'),
      describeSubagentItem({ type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/review', kind: 'interacted' }, 'interacted'),
      describeSubagentItem({ type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child', 'elsewhere'],
        agentsStates: { child: { status: 'completed', message: '检查通过' } } }, 'done'),
    ].filter((item) => item !== undefined)
    const state = [
      { id: 'child', parentThreadId: 'parent', agentNickname: 'Review', agentRole: 'reviewer', model: 'test-model', status: { type: 'idle' } },
      { id: 'other', parentThreadId: 'parent', agentNickname: 'Scan', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
      { id: 'elsewhere', parentThreadId: 'different', status: { type: 'active' } },
    ].reduce((current, thread) => applyNotification(current, {
      method: 'thread/started', params: { thread },
    } as Parameters<typeof applyNotification>[1]), emptyState())

    expect(collectSubagents(items.slice(0, 2), 'parent', state.threads)[0]?.status).toBe('运行中')
    expect(collectSubagents(items, 'parent', state.threads)).toEqual([
      expect.objectContaining({ key: 'thread:child', name: 'Review', role: 'reviewer', model: 'test-model', status: '已完成',
        task: '检查变更', result: '检查通过', activity: expect.arrayContaining([
          expect.objectContaining({ id: 'spawn' }), expect.objectContaining({ id: 'interacted' }), expect.objectContaining({ id: 'done' }),
        ]) }),
      expect.objectContaining({ key: 'thread:other', name: 'Scan', status: '待审批' }),
    ])
  })

  it('读取子会话期间保留新事件，历史不会被读取前的部分事件覆盖', () => {
    const before: ItemView = { kind: 'agent', id: 'answer', text: '检查', streaming: true }
    const stored: ItemView = { kind: 'agent', id: 'answer', text: '检查通过', streaming: false }
    const update: ItemView = { kind: 'agent', id: 'answer', text: '检查通过，已汇总', streaming: false }
    const next: ItemView = { kind: 'command', id: 'next', command: 'pwd', output: '', status: 'inProgress' }
    expect(mergeSubagentHistory([stored], [before, next], [before])).toEqual([stored, next])
    expect(mergeSubagentHistory([stored], [update, next], [before])).toEqual([update, next])
  })
})

describe('子代理头像', () => {
  it('同一标识稳定，不同标识分散到多种图标和配色', () => {
    expect(subagentAvatar('call-1')).toEqual(subagentAvatar('call-1'))
    const avatars = Array.from({ length: 32 }, (_, i) => subagentAvatar(`call-${i}`))
    for (const { icon, color } of avatars) {
      expect(icon).toBeGreaterThanOrEqual(0)
      expect(icon).toBeLessThan(SUBAGENT_AVATAR_VARIANTS)
      expect(color).toBeGreaterThanOrEqual(0)
      expect(color).toBeLessThan(SUBAGENT_AVATAR_VARIANTS)
    }
    expect(new Set(avatars.map(({ icon }) => icon)).size).toBeGreaterThan(4)
    expect(new Set(avatars.map(({ color }) => color)).size).toBeGreaterThan(4)
  })
})
