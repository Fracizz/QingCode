import { getLocale, t } from '../../protocol/src/i18n'
import type { AgentKind } from '../../protocol/src/messages'

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

export function contextUsageDetails(value: unknown, agent: AgentKind) {
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
    guidance: !usage
      ? recent ? t('当前没有窗口占用读数，处理长日志时可以先发送报错附近的片段。')
        : t('发送消息后，收到模型上报的用量就会显示在这里。')
      : usage.percent >= 90
        ? t('继续当前任务时，可先压缩会话，并在下一条消息重申关键约束。要换任务，可以另开会话。')
        : usage.percent >= 75
          ? t('下一轮要分析长日志或大文件时，可先贴报错附近的片段，或按文件分批处理。')
          : t('继续修同一个问题时，可以沿用这段对话。要排查另一项故障时，可以另开会话。'),
  }
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US')
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`
  return String(value)
}
