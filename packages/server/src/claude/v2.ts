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

/** content 已是 v2 UserInput 形态（含 image 项）时用；纯文本仍走 userMessageItem。 */
export function userMessageContentItem(id: string, content: Json[]): V2Item {
  return { type: 'userMessage', id, clientId: null, content }
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
    startedAt: nowSeconds(),
    completedAt: status === 'inProgress' ? null : nowSeconds(),
    durationMs: null,
  }
}

export function buildThread(meta: SessionMeta, turns: Json[] = []): Json {
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
    model: null,
    reasoningEffort: null,
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
  const utilization = finite(record.utilization)
  const type = typeof record.rateLimitType === 'string' ? record.rateLimitType : ''
  const mins = type === 'five_hour' ? 300 : type.startsWith('seven_day') ? 10080 : null
  const reset = finite(record.resetsAt)
  // Claude 只在接近/触发限额时上报，缺省窗口不虚构百分比。
  const primary: Json | null =
    utilization === null
      ? null
      : {
          usedPercent: Math.max(0, Math.min(100, utilization * 100)),
          windowDurationMins: mins,
          resetsAt: reset === null ? null : Math.abs(reset) > 1e11 ? reset / 1000 : reset,
        }
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
    rateLimitReachedType: record.status === 'rejected' ? 'rate_limit_reached' : null,
  }
}

/** result.usage 是每次 API 调用的 token 计数；成本按 SDK 的 total_cost_usd 估算值透传。 */
export function tokenUsage(result: unknown): Json {
  const record = asRecord(result)
  const usage = asRecord(record?.usage) ?? {}
  const input = finite(usage.input_tokens) ?? 0
  const output = finite(usage.output_tokens) ?? 0
  const cached = finite(usage.cache_read_input_tokens) ?? 0
  const cacheWrite = finite(usage.cache_creation_input_tokens) ?? 0
  const total = input + output + cached + cacheWrite
  const breakdown = {
    totalTokens: total,
    inputTokens: input + cached + cacheWrite,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
  }
  return {
    total: breakdown,
    last: breakdown,
    modelContextWindow: null,
    estimatedCostUsd: finite(record?.total_cost_usd) ?? 0,
    estimated: true,
  }
}
