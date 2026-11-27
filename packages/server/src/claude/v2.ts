/**
 * Codex app-server v2 形状的构造函数（纯逻辑）。
 * vendor/codex-protocol 是只读生成物，这里按它的字段名构造最小可用对象，
 * 额外的 itemId 等字段是给 @qn/codex-client reducer 定位用的，客户端会忽略未知字段。
 */
export type Json = Record<string, unknown>
export type V2Item = Json

export interface MapContext {
  threadId: string
  turnId: string
  cwd: string
  now?: number
}

export interface V2Notification {
  method: string
  params: Json
}

export interface SessionMeta {
  id: string
  cwd: string
  preview?: string
  name?: string
  createdAt?: number
  updatedAt?: number
  ephemeral?: boolean
}

/** Thread 的 model / reasoningEffort 是「当前配置」，不是逐轮遥测。 */
export interface ThreadConfig {
  model?: string | null
  reasoningEffort?: string | null
}

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Json | null {
  return isRecord(value) ? value : null
}

export function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function notification(method: string, params: Json): V2Notification {
  return { method, params }
}

export function itemStarted(ctx: MapContext, item: V2Item): V2Notification {
  return notification('item/started', {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId: scalarText(item.id),
    item,
    startedAtMs: ctx.now ?? Date.now(),
  })
}

export function itemCompleted(ctx: MapContext, item: V2Item): V2Notification {
  return notification('item/completed', {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId: scalarText(item.id),
    item,
    completedAtMs: ctx.now ?? Date.now(),
  })
}

export function deltaNotification(
  method: string,
  ctx: MapContext,
  itemId: string,
  delta: string,
  extra: Json = {},
): V2Notification {
  return notification(method, {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId,
    delta,
    ...extra,
  })
}

export function userMessageItem(id: string, value: string): V2Item {
  return {
    type: 'userMessage',
    id,
    clientId: null,
    content: [{ type: 'text', text: value, text_elements: [] }],
  }
}

/** 把一次提交的全部输入（含文本与图片）放在同一个条目中。 */
export function userMessageContentItem(id: string, content: Json[], clientId: string | null = null): V2Item {
  return { type: 'userMessage', id, clientId, content }
}

export function agentMessageItem(id: string, value: string): V2Item {
  return {
    type: 'agentMessage',
    id,
    text: value,
    phase: null,
    moderation: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  }
}

export function reasoningItem(id: string, value: string): V2Item {
  return {
    type: 'reasoning',
    id,
    summary: value ? [value] : [],
    content: [],
  }
}

export function commandExecutionItem(
  id: string,
  options: { command: string; cwd: string; status?: string; output?: string; exitCode?: number | null },
): V2Item {
  return {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: options.command,
    cwd: options.cwd,
    processId: null,
    source: 'agent',
    status: options.status ?? 'inProgress',
    commandActions: [],
    aggregatedOutput: options.output ?? '',
    exitCode: options.exitCode ?? null,
    durationMs: null,
  }
}

export function fileChangeItem(id: string, changes: Json[], status = 'inProgress'): V2Item {
  return { type: 'fileChange', id, changes, status }
}

export function dynamicToolCallItem(
  id: string,
  tool: string,
  input: unknown,
  status = 'inProgress',
): V2Item {
  return {
    type: 'dynamicToolCall',
    id,
    namespace: null,
    tool,
    arguments: input ?? {},
    status,
    contentItems: null,
    success: null,
    durationMs: null,
    // reducer 的 other 视图会优先展示 tool / summary 字段。
    summary: `${tool} ${summarizeInput(input)}`,
  }
}

export function mcpToolCallItem(
  id: string,
  tool: string,
  input: unknown,
  status = 'inProgress',
): V2Item {
  const parts = tool.split('__')
  return {
    type: 'mcpToolCall',
    id,
    server: parts[1] ?? 'mcp',
    environmentId: null,
    tool: parts.slice(2).join('__') || tool,
    arguments: input ?? {},
    status,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
    summary: `${tool} ${summarizeInput(input)}`,
  }
}

/** 参数摘要只用于展示，截断避免审批卡片被大段文件内容撑爆。 */
export function summarizeInput(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input ?? {}) ?? '{}'
  } catch {
    text = '{}'
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

export function buildTurn(
  id: string,
  items: V2Item[],
  status: string,
  error?: string | null,
  source: 'live' | 'history' = 'live',
): Json {
  return {
    id,
    rootTurnId: null,
    items,
    itemsView: 'full',
    status,
    error: error
      ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null }
      : null,
    // 历史没有计时时不能用读取时间；实时结束对象也不能把结束时刻填为起点。
    startedAt: source === 'live' && status === 'inProgress' ? nowSeconds() : null,
    completedAt: source === 'live' && status !== 'inProgress' ? nowSeconds() : null,
    durationMs: null,
  }
}

export function buildThread(meta: SessionMeta, turns: Json[] = [], config: ThreadConfig = {}): Json {
  const createdAt = meta.createdAt ?? nowSeconds()
  const updatedAt = meta.updatedAt ?? createdAt
  return {
    id: meta.id,
    sessionId: meta.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: meta.preview ?? '',
    ephemeral: meta.ephemeral ?? false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'legacy',
    modelProvider: 'anthropic',
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    createdAt,
    updatedAt,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd: meta.cwd,
    cliVersion: 'claude-agent-sdk',
    originator: 'qingcode-next',
    source: { custom: 'claude-agent-sdk' },
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: meta.name ?? null,
    turns,
  }
}

export function emptyRateLimitsResponse(): Json {
  const snapshot = rateLimitSnapshot()
  return {
    ordinaryUsageAllowed: null,
    rateLimits: snapshot,
    rateLimitsByLimitId: { claude: snapshot },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  }
}

export function rateLimitSnapshot(info: unknown = null): Json {
  const record = asRecord(info)
  // 没有限额事件时按 v2 契约返回全 null 快照，不能虚构利用率。
  if (!record) {
    return {
      limitId: null,
      limitName: null,
      normalModelSlug: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    }
  }
  const rejectedType = record.status === 'rejected' ? 'rate_limit_reached' : null
  // 新版 CLI 每轮都在同一事件的 unifiedWindows 里带上 5h/7d 利用率（SDK 公开类型尚未声明），
  // 只读取事件自带字段，缺失或格式不符时退回顶层 utilization。
  const windows = asRecord(record.unifiedWindows)
  const fiveHour = sdkWindow(windows?.five_hour, 300)
  const sevenDay = sdkWindow(windows?.seven_day, 10080)
  if (fiveHour || sevenDay) {
    return {
      limitId: CLAUDE_SDK_WINDOWS_LIMIT_ID,
      limitName: 'Claude SDK 限额窗口',
      normalModelSlug: null,
      primary: fiveHour,
      secondary: sevenDay,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: rejectedType,
    }
  }
  const type = typeof record.rateLimitType === 'string' ? record.rateLimitType : ''
  const mins = type === 'five_hour' ? 300 : type.startsWith('seven_day') ? 10080 : null
  // 旧版只在接近/触发限额时上报顶层 utilization，缺省窗口不虚构百分比。
  const primary = sdkWindow(record, mins, true)
  return {
    limitId: 'claude',
    limitName: 'Claude（仅接近/触发限额时上报）',
    normalModelSlug: null,
    primary,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: rejectedType,
  }
}

export const CLAUDE_SDK_WINDOWS_LIMIT_ID = 'claude-sdk-windows'

function windowResetsAt(value: unknown): number | null {
  return finite(asRecord(value)?.resetsAt)
}

/** 去掉已过重置时间的窗口；两个窗口都失效时返回 null。 */
export function activeSdkWindows(snapshot: Json, now = Date.now()): Json | null {
  const live = (value: unknown) => {
    const reset = windowResetsAt(value)
    return reset !== null && reset * 1000 > now ? value : null
  }
  const primary = live(snapshot.primary)
  const secondary = live(snapshot.secondary)
  return primary || secondary ? { ...snapshot, primary, secondary } : null
}

/** 下一个窗口重置的时间（秒），用于到点重新推送快照。 */
export function nextSdkWindowReset(snapshot: Json, now = Date.now()): number | null {
  const resets = [windowResetsAt(snapshot.primary), windowResetsAt(snapshot.secondary)]
    .filter((reset): reset is number => reset !== null && reset * 1000 > now)
  return resets.length ? Math.min(...resets) : null
}

/** utilization 为 0~1 的比例；resetsAt 兼容秒与毫秒。allowNullReset 仅用于旧版顶层字段。 */
function sdkWindow(value: unknown, windowDurationMins: number | null, allowNullReset = false): Json | null {
  const row = asRecord(value)
  const utilization = finite(row?.utilization)
  if (utilization === null || utilization < 0) return null
  const reset = finite(row?.resetsAt)
  const resetsAt = reset === null || reset <= 0 ? null : Math.abs(reset) > 1e11 ? reset / 1000 : reset
  if (resetsAt === null && !allowNullReset) return null
  // 比例换算成百分比时消除浮点误差（0.58 * 100 = 57.99…）
  return { usedPercent: Math.min(100, Math.round(utilization * 10_000) / 100), windowDurationMins, resetsAt }
}

/**
 * result.usage 是本轮所有 API 调用的累计 token，放在 total；成本按 SDK 的 total_cost_usd 估算值透传。
 * last 是最近一次调用的计数（即当前上下文占用），由调用方从 assistant 消息里记下；缺省时退回累计值。
 */
export function tokenUsage(result: unknown, context: { last?: Json | null; window?: number | null } = {}): Json {
  const record = asRecord(result)
  const breakdown = tokenBreakdown(asRecord(record?.usage) ?? {})
  return {
    total: breakdown,
    last: context.last ?? breakdown,
    // 没有可靠的最近一次调用计数时不给窗口：累计值跨多次调用，除以窗口会得出虚高的占用。
    modelContextWindow: context.last ? context.window ?? null : null,
    estimatedCostUsd: finite(record?.total_cost_usd) ?? 0,
    estimated: true,
  }
}

/** Anthropic usage 字段换成与 Codex 相同的 token 分项。 */
export function tokenBreakdown(usage: Record<string, unknown>): Json & { totalTokens: number } {
  const input = finite(usage.input_tokens) ?? 0
  const output = finite(usage.output_tokens) ?? 0
  const cached = finite(usage.cache_read_input_tokens) ?? 0
  const cacheWrite = finite(usage.cache_creation_input_tokens) ?? 0
  return {
    totalTokens: input + output + cached + cacheWrite,
    inputTokens: input + cached + cacheWrite,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
  }
}
