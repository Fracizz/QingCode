import { describe, expect, it } from 'vitest'
import { contextUsage, contextUsageDetails, estimatedTurnUsage } from './contextUsage'
import type { ItemView, ThreadView } from './conversation'
import { describeSubagentItem } from './subagents'

describe('上下文占用', () => {
  it('使用最近一轮 token 数，百分比上限为 100', () => {
    expect(contextUsage({ modelContextWindow: 100, last: { totalTokens: 25 }, total: { totalTokens: 500 } })).toEqual({ percent: 25, used: 25, window: 100 })
    expect(contextUsage({ modelContextWindow: 100, last: { totalTokens: 500 } })?.percent).toBe(100)
  })

  it('缺少完整用量时不显示占用', () => {
    expect(contextUsage({ modelContextWindow: null, last: { totalTokens: 0 } })).toBeNull()
    expect(contextUsage({ modelContextWindow: 100, last: {} })).toBeNull()
    expect(contextUsage({ modelContextWindow: Infinity, last: { totalTokens: 10 } })).toBeNull()
  })
})

describe('单轮用量', () => {
  it('可读取无上下文大小的单轮统计，不带出费用', () => {
    const usage = { estimated: true, modelContextWindow: null, last: { totalTokens: 128 }, estimatedCostUsd: 0 }
    expect(contextUsage(usage)).toBeNull()
    expect(estimatedTurnUsage(usage)).toEqual({ tokens: 128 })
  })

  it('忽略标准上下文统计和无效字段', () => {
    expect(estimatedTurnUsage({ last: { totalTokens: 10 } })).toBeNull()
    expect(estimatedTurnUsage({ estimated: true, last: { totalTokens: -1 }, estimatedCostUsd: Infinity })).toBeNull()
    expect(estimatedTurnUsage({ estimated: true, last: { totalTokens: 5 } })).toEqual({ tokens: 5 })
  })
})

describe('会话用量明细', () => {
  it('仅展示已上报的分项，缓存和推理作为输入和输出的子项', () => {
    const last = { totalTokens: 1700, inputTokens: 1500, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 120 }
    const { overview, recent } = contextUsageDetails({ last, modelContextWindow: 2000 }, 'codex')
    expect(overview?.stats.map(({ count }) => count)).toEqual([1700, 300, 2000])
    expect(recent?.tokens).toBeNull()
    expect(recent?.rows.map(({ count, included }) => [count, included])).toEqual([[1500, false], [800, true], [200, false], [120, true]])
  })

  it('超过窗口时剩余为 0，缺窗口时仍显示 Claude 上报的用量', () => {
    const report = { last: { totalTokens: 102, inputTokens: 102, outputTokens: 0, reasoningOutputTokens: 0 }, estimated: true }
    const { overview } = contextUsageDetails({ ...report, modelContextWindow: 100 }, 'claude')
    expect(overview).toMatchObject({ percent: 100, estimated: true })
    expect(overview?.stats[1]?.count).toBe(0)
    const fallback = contextUsageDetails(report, 'claude')
    expect(fallback.overview).toBeNull()
    expect(fallback.recent?.tokens).toBe(102)
    expect(fallback.recent?.rows.map(({ count }) => count)).toEqual([102, 0])
  })

  it('pi 的窗口读数缺少单轮累计时不重复显示窗口读数', () => {
    const last = { totalTokens: 4000 }
    const { overview, recent } = contextUsageDetails({ last, total: last, modelContextWindow: 10_000, estimated: true }, 'pi')
    expect(overview?.used).toBe(4000)
    expect(recent).toBeNull()
  })

  it.each(['codex', 'claude', 'pi'] as const)('%s 只统计选中轮次内已加载的调用条目', (agent) => {
    const command = { kind: 'command', id: 'shell', status: 'completed', command: 'pwd', output: '' } as const
    const tool: ItemView = { kind: 'other', id: 'read', type: 'dynamicToolCall', summary: 'read',
      toolDetails: { name: 'read', result: '' } }
    const items: ItemView[] = [
      command, tool, { ...tool, id: 'read-2' }, tool,
      { kind: 'other', id: 'result', type: 'functionCallOutput', summary: '' },
      { kind: 'other', id: 'compact', type: 'contextCompaction', summary: '' },
      describeSubagentItem({ type: 'collabAgentToolCall', tool: 'spawnAgent' }, 'delegate')!,
      describeSubagentItem({ type: 'subAgentActivity', kind: 'spawned' }, 'activity')!,
    ]
    const thread: ThreadView = { id: 'thread', status: 'running', activeTurnId: 'live', items, pendingApprovals: [], turns: [
      { id: 'live', startedAtMs: null, durationMs: null, itemIds: items.slice(1).map(({ id }) => id) },
      { id: 'latest-history', startedAtMs: null, durationMs: null, itemIds: ['shell'] },
    ] }
    expect(contextUsageDetails(null, agent, thread).tools).toEqual({
      title: '本轮工具调用', total: 3, rows: [{ label: 'read', count: 2 }, { label: '子代理', count: 1 }],
    })
    expect(contextUsageDetails(null, agent, { ...thread, status: 'idle', activeTurnId: null }).tools).toEqual({
      title: '最近一轮工具调用', total: 1, rows: [{ label: '命令执行', count: 1 }],
    })
  })

  it('工具较多时合并其余调用，保留总数', () => {
    const items: ItemView[] = Array.from({ length: 9 }, (_, index) => ({
      kind: 'other', type: 'mcpToolCall', id: `mcp-${index}`, summary: '',
      toolDetails: { name: `MCP · tool_${index}`, result: '' },
    }))
    const thread: ThreadView = { id: 'thread', status: 'idle', activeTurnId: null, items, pendingApprovals: [],
      turns: [{ id: 'latest', startedAtMs: null, durationMs: null, itemIds: items.map(({ id }) => id) }] }
    const { tools } = contextUsageDetails(null, 'codex', thread)
    expect(tools?.total).toBe(9)
    expect(tools?.rows).toHaveLength(6)
    expect(tools?.rows.at(-1)).toEqual({ label: '其余工具', count: 4 })
  })
})
