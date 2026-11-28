import { accessOptions, requestSubagents, supportsSubagentRequests, type AccessMode, type SessionAccessMode, type TurnOverrides, type UserInput } from '@qn/codex-client'
import { archivedThreadKey, isAgentKind } from './agents'
import { buildMobileTurnInput, formatQuotedMessage, parseStoredRecord, type ChatDraft } from './state'
import type { AgentKind, Connection } from './types'

export type MobileTurnAccess = { accessMode: SessionAccessMode; inheritAccess?: boolean }

export type QueuedSend = ChatDraft & {
  id: string
  attachments: UserInput[]
  delegate: boolean
  overrides: TurnOverrides
  accessMode?: AccessMode
  /** 排队的会话压缩：按队列顺序执行，不是发给 Agent 的消息。 */
  compact?: boolean
  saving?: boolean
  sending?: boolean
  /** 交给电脑的请求可能已送达，收回时要先核对代发结果。 */
  relayPending?: true
  error?: string
}

export const QUEUE_STORAGE_KEY = 'queuedSends'
// i18n-ignore: 随发送队列持久化并参与比较，展示时用 translateMessage 翻译
export const UNCONFIRMED_QUEUED_SEND = '上次发送结果未确认，请核对对话后再继续'
// i18n-ignore: 兼容旧版持久化的恢复提示
const LEGACY_RESTORED_QUEUE = '已恢复排队消息，等待继续发送'
// i18n-ignore: 兼容旧版误存为暂停原因的分支提示
const LEGACY_QUEUE_FORK_UNAVAILABLE = '当前还没有已结束的一轮，可用「新会话开始」'

type Queues = Record<string, QueuedSend[]>
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function queuedInput(agent: AgentKind, item: Pick<QueuedSend, 'text' | 'annotations' | 'attachments' | 'delegate'>): UserInput[] {
  const input = buildMobileTurnInput(agent, formatQuotedMessage(item.annotations, item.text), item.attachments)
  return item.delegate && supportsSubagentRequests(agent) ? requestSubagents(input) : input
}

export function mobileTurnFits(targetId: string, agent: AgentKind, threadId: string | null,
  input: UserInput[], overrides: TurnOverrides, expectedTurnId?: string, access?: MobileTurnAccess): boolean {
  const params = expectedTurnId ? { threadId, expectedTurnId, input } : { threadId: threadId ?? 'x'.repeat(256), input, ...overrides }
  const msg = {
    id: 'x'.repeat(80),
    method: expectedTurnId ? 'turn/steer' : 'turn/start',
    params: { ...params, clientUserMessageId: 'x'.repeat(36) },
  }
  const managed = !expectedTurnId && access && (access.inheritAccess !== undefined || access.accessMode !== 'default')
  const body = {
    method: managed ? 'mobile.turn.start' : 'codex.send',
    params: { targetId, agent, msg, ...(managed ? access : {}), ...(expectedTurnId ? {} : { replyViaHttp: true }) },
    agent,
  }
  return new TextEncoder().encode(JSON.stringify(body)).length <= 1_048_576
}

/** 交给电脑网关代发的一条：与手机直发同样的 mobile.turn.start / codex.send 请求体，msg.id 由网关生成。 */
export type RelayRequest = {
  method: 'mobile.turn.start' | 'codex.send'
  params: { targetId: string; agent: AgentKind; msg: { method: 'turn/start'; params: Record<string, unknown> } } & Partial<MobileTurnAccess>
}

/**
 * 按手机直发的规则组装代发请求；访问模式不受支持或超过网关体积上限时抛错，这条留在手机本地。
 * 与 store 里 startMessageTurn 的参数保持一致：默认权限且未继承总控时走 codex.send。
 */
export function relayRequest(
  targetId: string, threadId: string, agent: AgentKind, item: Pick<QueuedSend, 'text' | 'annotations' | 'attachments' | 'delegate' | 'overrides'>,
  access: MobileTurnAccess, accessSupported: boolean, clientUserMessageId: string,
): RelayRequest {
  // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
  if (access.accessMode !== 'default' && !accessSupported) throw new Error('电脑或目标服务暂不支持当前访问模式，请升级后重试')
  const input = queuedInput(agent, item)
  const { overrides } = item
  // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
  if (!mobileTurnFits(targetId, agent, threadId, input, overrides, undefined, access)) throw new Error('消息和附件合计超过 1 MiB，请移除部分内容后再发送')
  const params: Record<string, unknown> = {
    threadId, input, clientUserMessageId,
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.effort ? { effort: overrides.effort } : {}),
    ...(overrides.serviceTier !== undefined ? { serviceTier: overrides.serviceTier } : {}),
  }
  const msg = { method: 'turn/start' as const, params }
  return access.accessMode === 'default' && access.inheritAccess === undefined
    ? { method: 'codex.send', params: { targetId, agent, msg } }
    : { method: 'mobile.turn.start', params: { targetId, agent, msg, ...access } }
}

/** 去掉电脑已发出的消息，收到暂停原因时记到剩余队首。 */
export function applyRelayResult(list: QueuedSend[], sentIds: readonly string[], error?: string): QueuedSend[] {
  const sent = new Set(sentIds)
  const rest = sent.size ? list.filter((item) => !sent.has(item.id)) : list
  const first = rest[0]
  if (!first || !error || first.error) return rest.length === list.length ? list : rest
  return [{ ...first, error }, ...rest.slice(1)]
}

/** 电脑丢失代发记录时，逐条标记可能已发出的消息，避免重复提交。 */
export function releaseRelayedSends(list: QueuedSend[], known: boolean): QueuedSend[] {
  if (!list.some((item) => item.relayPending)) return list
  return list.map((item) => {
    if (!item.relayPending) return item
    const { relayPending: _relayPending, ...rest } = item
    return known ? rest : { ...rest, error: UNCONFIRMED_QUEUED_SEND }
  })
}

export function serializeQueues(queues: Queues, connections: readonly Connection[]): string {
  const fingerprints = new Map(connections.map(({ id, fp }) => [id, fp]))
  return JSON.stringify(Object.fromEntries(Object.entries(queues).flatMap(([key, items]) => {
    const desktopId = (JSON.parse(key) as string[])[0] ?? ''
    const fp = fingerprints.get(desktopId)
    return fp && items.length ? [[key, { fp, items: items.map(({ saving: _saving, ...item }) => item) }]] : []
  })))
}

export function restoreQueues(raw: string | null, connections: readonly Connection[], archived: Record<string, true>): Queues {
  const fingerprints = new Map(connections.map(({ id, fp }) => [id, fp]))
  const queues: Queues = {}
  for (const [key, entry] of Object.entries(parseStoredRecord(raw))) {
    if (!isRecord(entry) || !Array.isArray(entry.items)) continue
    let address: unknown
    try { address = JSON.parse(key) } catch { continue }
    if (!Array.isArray(address) || address.length !== 4) continue
    const [desktopId, targetId, agent, threadId] = address
    if (typeof desktopId !== 'string' || typeof targetId !== 'string' || typeof threadId !== 'string' || !isAgentKind(agent)
      || typeof entry.fp !== 'string' || fingerprints.get(desktopId) !== entry.fp
      || archived[archivedThreadKey(desktopId, targetId, { agent, id: threadId })]) continue
    const items = entry.items.filter((item): item is QueuedSend => isRecord(item)
      && typeof item.id === 'string' && typeof item.text === 'string' && Array.isArray(item.annotations)
      && Array.isArray(item.attachments) && isRecord(item.overrides) && typeof item.delegate === 'boolean')
    if (!items.length) continue
    // 普通待发项继续排队。正在直发的消息没有可供收回的回执，需要保留原文供核对。
    queues[key] = items.map((item) => {
      const accessMode = accessOptions[agent].find((option) => option.mode === item.accessMode)?.mode
      let error = typeof item.error === 'string' && item.error !== LEGACY_RESTORED_QUEUE ? item.error : undefined
      // 保留旧记录的暂停状态，避免升级后把用户想带到新会话的消息自动发回原会话。
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      if (error === LEGACY_QUEUE_FORK_UNAVAILABLE) error = '队列已暂停'
      return {
        ...item,
        accessMode,
        sending: false,
        relayPending: item.relayPending === true ? true : undefined,
        error: item.sending ? UNCONFIRMED_QUEUED_SEND : error,
      }
    })
  }
  return queues
}
