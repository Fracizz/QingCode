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
  saving?: boolean
  sending?: boolean
  error?: string
}

export const QUEUE_STORAGE_KEY = 'queuedSends'
// i18n-ignore: 随发送队列持久化并参与比较，展示时用 translateMessage 翻译
export const UNCONFIRMED_QUEUED_SEND = '上次发送结果未确认，请核对对话后再继续'

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

/** 收回代发队列：去掉网关已发出的消息，暂停原因落到队首。known 为 false 表示电脑已丢失这组队列。 */
export function applyRelayResult(list: QueuedSend[], sentIds: readonly string[], error: string | undefined, known = true): QueuedSend[] {
  const sent = new Set(sentIds)
  const rest = list.filter((item) => !sent.has(item.id))
  if (rest.length === 0) return rest.length === list.length ? list : rest
  // 电脑重启后无法确认哪些已发出，暂停等用户核对，避免重复发送。
  const head = known ? error : UNCONFIRMED_QUEUED_SEND
  if (rest[0]!.error === head && rest.length === list.length) return list
  return [{ ...rest[0]!, sending: false, error: head }, ...rest.slice(1)]
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
    // 重开后无法确认中途发送的结果，保留原文供核对并等待明确操作。
    queues[key] = items.map((item, index) => {
      const accessMode = accessOptions[agent].find((option) => option.mode === item.accessMode)?.mode
      return {
        ...item,
        accessMode,
        sending: false,
        error: item.sending ? UNCONFIRMED_QUEUED_SEND
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          : typeof item.error === 'string' ? item.error : index === 0 ? '已恢复排队消息，等待继续发送' : undefined,
      }
    })
  }
  return queues
}
