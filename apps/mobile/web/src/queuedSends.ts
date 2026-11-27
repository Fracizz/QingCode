import { accessOptions, requestSubagents, supportsSubagentRequests, type AccessMode, type TurnOverrides, type UserInput } from '@qn/codex-client'
import { archivedThreadKey, isAgentKind } from './agents'
import { buildMobileTurnInput, formatQuotedMessage, parseStoredRecord, type ChatDraft } from './state'
import type { AgentKind, Connection } from './types'

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
export const UNCONFIRMED_QUEUED_SEND = '上次发送结果未确认，请核对对话后再继续'

type Queues = Record<string, QueuedSend[]>
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function queuedInput(agent: AgentKind, item: Pick<QueuedSend, 'text' | 'annotations' | 'attachments' | 'delegate'>): UserInput[] {
  const input = buildMobileTurnInput(agent, formatQuotedMessage(item.annotations, item.text), item.attachments)
  return item.delegate && supportsSubagentRequests(agent) ? requestSubagents(input) : input
}

export function mobileTurnFits(targetId: string, agent: AgentKind, threadId: string | null,
  input: UserInput[], overrides: TurnOverrides, expectedTurnId?: string, accessMode: AccessMode = 'default'): boolean {
  const params = expectedTurnId ? { threadId, expectedTurnId, input } : { threadId: threadId ?? 'x'.repeat(256), input, ...overrides }
  const msg = { id: 'x'.repeat(80), method: expectedTurnId ? 'turn/steer' : 'turn/start', params }
  const managed = !expectedTurnId && accessMode !== 'default'
  const body = {
    method: managed ? 'mobile.turn.start' : 'codex.send',
    params: { targetId, agent, msg, ...(managed ? { accessMode } : {}) },
    agent,
  }
  return new TextEncoder().encode(JSON.stringify(body)).length <= 1_048_576
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
          : typeof item.error === 'string' ? item.error : index === 0 ? '已恢复排队消息，等待继续发送' : undefined,
      }
    })
  }
  return queues
}
