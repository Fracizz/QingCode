import { getLocale, t } from '../../protocol/src/i18n'
import type { AgentKind } from '../../protocol/src/messages'
import type { ItemView, ThreadView } from './conversation'

export type ContextUsage = { percent: number; used: number; window: number }

export type EstimatedTurnUsage = { tokens: number }

/** Claude 和 pi 上报单轮统计，工具调用可使一轮包含多次模型请求。 */
export function estimatedTurnUsage(value: unknown): EstimatedTurnUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as { estimated?: unknown; last?: { totalTokens?: unknown } }
  if (usage.estimated !== true) return null
  const tokens = nonnegative(usage.last?.totalTokens)
  return tokens === null ? null : { tokens }
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 缺少本轮 token 数或上下文窗口时无法估计占用。 */
export function contextUsage(value: unknown): ContextUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as { modelContextWindow?: unknown; last?: { totalTokens?: unknown } }
  const window = usage.modelContextWindow
  const used = usage.last?.totalTokens
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0
    || typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  return { used, window, percent: Math.min(100, Math.round((used / window) * 100)) }
}

type UsageReport = Partial<Record<'totalTokens' | 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens' | 'reasoningOutputTokens', unknown>>

export function contextUsageDetails(value: unknown, agent: AgentKind, thread?: ThreadView) {
  const usage = contextUsage(value)
  const report = typeof value === 'object' && value !== null
    ? value as { last?: UsageReport; total?: UsageReport; estimated?: unknown }
    : undefined
  // pi 的窗口占用来自单独的读数，分项依然是整轮用量。
  const snapshot = agent === 'pi' && usage ? report?.total : report?.last
  const rows = [
    { label: t('输入'), count: nonnegative(snapshot?.inputTokens), included: false },
    { label: t('其中缓存命中'), count: nonnegative(snapshot?.cachedInputTokens), included: true },
    { label: t('其中缓存写入'), count: nonnegative(snapshot?.cacheWriteInputTokens), included: true },
    { label: t('输出'), count: nonnegative(snapshot?.outputTokens), included: false },
    { label: t('其中推理'), count: nonnegative(snapshot?.reasoningOutputTokens), included: true },
  ].flatMap(({ label, count, included }) => count === null || (included && count === 0)
    ? [] : [{ label, count, included }])

  // pi 没有单轮统计时也会把窗口读数填到 total，仅有总数时不重复显示。
  const tokens = !usage || (agent === 'pi' && rows.length > 0) ? nonnegative(snapshot?.totalTokens) : null
  const recent = tokens === null && rows.length === 0 ? null : {
    title: agent === 'pi' && usage ? t('最近一轮用量') : usage ? t('最近上报明细') : t('最近上报用量'),
    tokens,
    rows,
  }
  return {
    overview: usage && {
      ...usage,
      stats: [
        { label: t('已用'), count: usage.used },
        { label: t('剩余'), count: Math.max(0, usage.window - usage.used) },
        { label: t('窗口上限'), count: usage.window },
      ],
      estimated: report?.estimated === true,
    },
    recent,
    tools: thread ? turnToolUsage(thread) : null,
  }
}

function toolName(item: ItemView): string | undefined {
  if (item.kind === 'command') return t('命令执行')
  if (item.kind === 'fileChange') return t('文件修改')
  if (item.kind === 'subagent' && item.toolCall) return t('子代理')
  if (item.kind !== 'other') return
  switch (item.type) {
    case 'webSearch': return t('网页搜索')
    case 'imageView': return t('查看图片')
    case 'imageGeneration': return t('生成图片')
    case 'mcpToolCall': return item.toolDetails?.name || t('MCP 工具')
    case 'dynamicToolCall': return item.toolDetails?.name || item.summary || t('工具调用')
  }
}

function turnToolUsage(thread: ThreadView) {
  const activeId = thread.activeTurnId
  const turn = activeId ? thread.turns?.findLast(({ id }) => id === activeId) : thread.turns?.at(-1)
  if (!turn?.itemIds.length) return null
  // 只统计这一轮实际收到的调用条目，重放、结束通知与子代理状态更新不重复计数。
  const ids = new Set(turn.itemIds)
  const counts = new Map<string, number>()
  let total = 0
  for (const item of thread.items) {
    if (!ids.delete(item.id)) continue
    const name = toolName(item)
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
    total++
  }
  if (!total) return null
  const rows = [...counts].sort(([, a], [, b]) => b - a).map(([label, count]) => ({ label, count }))
  const limit = 6
  const visible = rows.slice(0, rows.length > limit ? limit - 1 : limit)
  if (rows.length > limit) {
    const count = total - visible.reduce((shown, row) => shown + row.count, 0)
    visible.push({ label: t('其余工具'), count })
  }
  return { title: activeId ? t('本轮工具调用') : t('最近一轮工具调用'), total, rows: visible }
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US')
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`
  return String(value)
}
