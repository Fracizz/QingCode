import { describe, expect, it } from 'vitest'
import type { UserInput } from './codex-types'
import { describeSubagentItem, requestSubagents, supportsSubagentRequests } from './subagents'

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
  })
})
